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
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

import { HOOK_EVENT_NAMES } from '../lib/hook-events.ts'

const FORWARDER = '${CLAUDE_PLUGIN_ROOT}/bin/hoai-hook.mjs'

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
  // Notification, SubagentStart, SubagentStop) costs a process per occurrence
  // for nothing. Adding one must be an edit here, not a drive by.
  for (const unregistered of ['PermissionRequest', 'Notification', 'SubagentStart',
    'SubagentStop', 'PostToolBatch', 'StopFailure', 'TaskCreated', 'TaskCompleted']) {
    assert.ok(
      !(unregistered in manifest.hooks),
      `${unregistered} is not part of this release; stage 8 has its own gate`,
    )
  }
})

test('every entry is the exec form, with the plugin root placeholder', () => {
  const all = entries()
  assert.equal(all.length, HOOK_EVENT_NAMES.length, 'one entry per event, routing happens in the mapper')
  for (const entry of all) {
    assert.equal(entry.type, 'command')
    assert.equal(entry.command, 'node', 'with args present, command is the EXECUTABLE, not a shell line')
    assert.deepEqual(entry.args, [FORWARDER])
    assert.equal(entry.timeout, 5, 'seconds, not milliseconds')
    assert.equal(entry.async, true, 'a hook that blocks a tool call is a defect')
    assert.equal('asyncRewake' in entry, false, 'waking the model is not this lane job')
  }
})

test('no matcher anywhere: two matchers on one event would double the processes', () => {
  for (const [event, matchers] of Object.entries(manifest.hooks)) {
    assert.equal(matchers.length, 1, `${event} must declare one matcher object`)
    assert.equal('matcher' in matchers[0]!, false, `${event} must not narrow by tool name`)
  }
})

test('plugin.json declares no hooks key: the standard file is loaded automatically', () => {
  assert.equal('hooks' in plugin, false)
})
