/**
 * hooks/hooks.json: the file the Claude Code CLI reads to know this plugin
 * wants hook events at all.
 *
 * Facts this file is pinned against, all read out of the shipped CLI binary
 * (2.1.278) during the stage 4 gate:
 *
 * - "The standard hooks/hooks.json is loaded automatically, so manifest.hooks
 *   should only reference additional hook files." So the manifest lives here
 *   and .claude-plugin/plugin.json must NOT grow a `hooks` key: that would be
 *   a second way to be wrong for no benefit.
 * - `args` is the exec form: "When present, `command` is resolved as an
 *   executable and spawned directly with these arguments, no shell. Path
 *   placeholders like ${CLAUDE_PLUGIN_ROOT} are substituted per-element as
 *   plain strings, so paths with quotes, $, or backticks never reach a shell
 *   parser." That is why `command` is the bare program name `node` and the
 *   script path is args[0], and it is what keeps a Windows path with a space
 *   in it from being re-parsed by PowerShell.
 * - `async: true` keeps the hook off the critical path; `asyncRewake` would
 *   wake the MODEL on exit code 2, which is emphatically not this lane's job.
 * - Exit 2 on PreToolUse BLOCKS the tool call, so the forwarder always exits
 *   0 (pinned in test/hoai-hook.test.ts, task C2).
 *
 * ONE DELIBERATE EXCEPTION SINCE 0.49.0, and it is a second script, not a
 * change to the forwarder. Until then this file asserted that every entry is
 * async ("a hook that blocks a tool call is a defect"), one entry per event and
 * one matcher object per event. The hard floor reverses all three for exactly
 * one entry: bin/hoai-floor-hook.mjs, a SECOND PreToolUse matcher object with
 * `async: false`, a matcher for the shell, edit and MCP tools and a 3 second
 * timeout. The reason is the owner's, not ours: with "Always ask before risky
 * actions" on, a recursive delete, a force push, a change inside .git, to an
 * .env file or to a home settings file, or a tool that sends, posts, pays or
 * deletes must stop and ask even under --dangerously-skip-permissions, and
 * the live probe (map part 24, run D1) proved a blocking hook's `ask` is the
 * only thing the CLI honours in that mode. It is safe to block on because it
 * only ever ASKS (never deny, never exit 2), it fails open, and it gives up
 * inside 2 seconds. The forwarder is unchanged: every one of its entries is
 * still async, still exits 0, and still cannot stop anything.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

import { HOOK_EVENT_NAMES } from '../lib/hook-events.ts'

const FORWARDER = '${CLAUDE_PLUGIN_ROOT}/bin/hoai-hook.mjs'
const FLOOR = '${CLAUDE_PLUGIN_ROOT}/bin/hoai-floor-hook.mjs'
/** Anchored: the CLI tests a matcher that is not a plain word list as a
 *  regex, so an unanchored `Write` would also fire for `TodoWrite`. */
const FLOOR_MATCHER = '^(Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|mcp__.*)$'

interface HookEntry {
  type?: string
  command?: string
  args?: string[]
  timeout?: number
  async?: boolean
  asyncRewake?: boolean
  matcher?: string
}

interface HookMatcher {
  matcher?: string
  hooks?: HookEntry[]
}

const raw = readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')
const manifest = JSON.parse(raw) as { description?: string; hooks: Record<string, HookMatcher[]> }
const plugin = JSON.parse(
  readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

const entries = (): HookEntry[] =>
  Object.values(manifest.hooks).flatMap((matchers) => matchers.flatMap((m) => m.hooks ?? []))

const isFloorEntry = (entry: HookEntry): boolean => (entry.args ?? []).includes(FLOOR)

test('the manifest parses and carries a one line description', () => {
  assert.equal(typeof manifest.description, 'string')
  assert.ok((manifest.description ?? '').length > 0)
  const emDash = String.fromCharCode(0x2014)
  const enDash = String.fromCharCode(0x2013)
  assert.ok(!raw.includes(emDash) && !raw.includes(enDash), 'no em or en dashes')
})

test('the declared event set is exactly the set the mapper handles', () => {
  assert.deepEqual(Object.keys(manifest.hooks).sort(), [...HOOK_EVENT_NAMES].sort())
})

test('the registered set is deliberate: no event fires that nothing reads', () => {
  // Registering an event that never fired in the gate (PermissionRequest,
  // Notification, SubagentStart) costs a process per occurrence for nothing.
  // Adding one must be an edit here, not a drive by.
  //
  // Stage 8 registers SubagentStop and ONLY SubagentStop, and the two are not
  // a pair. A SubagentStop carries the child's agent_id and its last message,
  // which is what closes a helper row and gives it its result. A SubagentStart
  // carries no description, so it can name nothing, and no tool_use_id, so it
  // can be joined to nothing; it also fires BEFORE the launch response that
  // first says which agent id belongs to which row, so it cannot even seed the
  // index. Registering it would cost one process per child launch to read a
  // payload nothing can use.
  assert.ok('SubagentStop' in manifest.hooks, 'a helper row closes on this event')
  for (const unregistered of ['PermissionRequest', 'Notification', 'SubagentStart',
    'PostToolBatch', 'StopFailure', 'TaskCreated', 'TaskCompleted']) {
    assert.ok(
      !(unregistered in manifest.hooks),
      `${unregistered} is not part of this release; stage 8 has its own gate`,
    )
  }
})

test('every FORWARDER entry is the exec form, async, with the plugin root placeholder', () => {
  const forwarders = entries().filter((entry) => !isFloorEntry(entry))
  assert.equal(
    forwarders.length,
    HOOK_EVENT_NAMES.length,
    'one forwarder entry per event, routing happens in the mapper',
  )
  for (const entry of forwarders) {
    assert.equal(entry.type, 'command')
    assert.equal(entry.command, 'node', 'with args present, command is the EXECUTABLE, not a shell line')
    assert.deepEqual(entry.args, [FORWARDER])
    assert.equal(entry.timeout, 5, 'seconds, not milliseconds')
    // Still true of the forwarder, and it must stay true: a TELEMETRY hook
    // that blocks a tool call is a defect. The one blocking entry is the floor
    // hook below, a different script with its own reason.
    assert.equal(entry.async, true, 'a telemetry hook that blocks a tool call is a defect')
    assert.equal('asyncRewake' in entry, false, 'waking the model is not this lane job')
  }
  // Nothing else: every entry is either the forwarder or the floor hook.
  assert.equal(entries().length, HOOK_EVENT_NAMES.length + 1, 'the forwarder per event, plus the one floor entry')
})

test('the floor hook is the ONE blocking entry, and the reason is written here', () => {
  // Reversed on purpose in 0.49.0 (see the header): the owner's "Always ask
  // before risky actions" needs a hook that STOPS a listed call under full
  // access, and the probe proved nothing else does (map part 24, run D1). It
  // is safe to block on because it only asks, fails open and gives up inside
  // two seconds (test/hoai-floor-hook.test.ts pins all three).
  const floors = entries().filter(isFloorEntry)
  assert.equal(floors.length, 1, 'exactly one floor entry')
  const floor = floors[0]!
  assert.equal(floor.type, 'command')
  assert.equal(floor.command, 'node', 'the runtime the MCP server itself is launched with')
  assert.deepEqual(floor.args, [FLOOR])
  assert.equal(floor.async, false, 'it must BLOCK: an async ask arrives after the call already ran')
  assert.equal(floor.timeout, 3, 'seconds: above the script own 1.5 s budget, far below the CLI 60 s default')
  assert.equal('asyncRewake' in floor, false)
  // It lives on PreToolUse and nowhere else: it decides before a call runs.
  for (const [event, matchers] of Object.entries(manifest.hooks)) {
    const here = matchers.flatMap((m) => m.hooks ?? []).filter(isFloorEntry)
    assert.equal(here.length, event === 'PreToolUse' ? 1 : 0, `${event} floor entries`)
  }
  // And the forwarder was not touched to make room for it.
  assert.equal(entries().filter((entry) => (entry.args ?? []).includes(FORWARDER)).length, HOOK_EVENT_NAMES.length)
})

test('one matcher object per event, except PreToolUse, whose second is the floor', () => {
  // Two matchers on one event double the processes, so the forwarder still
  // declares exactly one, un-narrowed, everywhere. PreToolUse carries the
  // floor's own matcher object beside it, narrowed to the tools the floor can
  // match, which is the reversal the header explains.
  for (const [event, matchers] of Object.entries(manifest.hooks)) {
    if (event === 'PreToolUse') {
      assert.equal(matchers.length, 2, 'the forwarder, then the floor')
      assert.equal('matcher' in matchers[0]!, false, 'the forwarder is never narrowed by tool name')
      assert.deepEqual(matchers[0]!.hooks?.map((h) => h.args), [[FORWARDER]])
      assert.equal(matchers[1]!.matcher, FLOOR_MATCHER)
      assert.deepEqual(matchers[1]!.hooks?.map((h) => h.args), [[FLOOR]])
      continue
    }
    assert.equal(matchers.length, 1, `${event} must declare one matcher object`)
    assert.equal('matcher' in matchers[0]!, false, `${event} must not narrow by tool name`)
  }
})

test('the floor matcher covers the shell, edit and MCP tools and nothing else', () => {
  const re = new RegExp(FLOOR_MATCHER)
  for (const tool of ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
    'mcp__gmail__send_email', 'mcp__plugin_hoai_bgos__reply']) {
    assert.ok(re.test(tool), `${tool} must reach the floor hook`)
  }
  for (const tool of ['Read', 'Glob', 'Grep', 'Agent', 'TodoWrite', 'BashOutput', 'WebFetch',
    'TaskCreate', 'ToolSearch', 'xmcp__a__b']) {
    assert.equal(re.test(tool), false, `${tool} must not start a blocking process`)
  }
})

test('plugin.json declares no hooks key: the standard file is loaded automatically', () => {
  assert.equal('hooks' in plugin, false)
})
