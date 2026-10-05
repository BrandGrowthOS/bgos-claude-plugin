// `refresh_hook_entries` routes the DENY and the HOOKS differently, and the
// difference is the whole reason the deny reaches agents that already exist.
//
// The hooks half is gated: it runs only for a workspace whose settings file
// already names hoai-hook.mjs, because stacking a second hook entry on a
// workspace that gets its hooks elsewhere leaves a dead one firing. The deny
// half must NOT inherit that gate, because a permission cannot duplicate
// anything and every agent folder wants it. Case 2 below is the shape every
// pre-existing agent is in and the shape the old code did nothing for.
//
// This runs the REAL function out of bin/bgos-agent with its two workers
// stubbed to markers, so it asserts which one the routing CHOSE rather than
// what either wrote (that is denied-tools-reach.test.ts's job). Nothing else
// in the CLI is sourced: sourcing a dispatcher to inspect one function runs
// the dispatcher.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bashOrSkip, bashPath } from './helpers/posix-bash.ts'

const AGENT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'bin', 'bgos-agent')

/** A bash-safe single-quoted word. */
const shq = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

/**
 * The real function, with everything it calls stubbed to a printed marker. Run under Git for
 * Windows' bash on Windows (never the WSL launcher, which cannot open a Windows path), with the
 * workdir handed over in bash form and quoted. Returns null when the test was skipped.
 */
function runRefresh(t: TestContext, workdir: string): string | null {
  const bash = bashOrSkip(t)
  if (!bash) return null
  const src = readFileSync(AGENT, 'utf8')
  const body = src.match(/^refresh_hook_entries\(\) \{[\s\S]*?^\}/m)
  assert.ok(body, 'refresh_hook_entries not found in bin/bgos-agent')
  const harness = [
    'OS=Darwin',
    'PLUGIN_DIR=/stub/plugin',
    'plist_for() { echo "/stub/missing.plist"; }',
    'unitfile_for() { echo "/stub/missing.service"; }',
    `default_workdir_for() { printf '%s\\n' ${shq(bashPath(workdir))}; }`,
    'install_hook_entries() { echo "RAN:hooks"; }',
    'install_denied_tools() { echo "RAN:deny"; }',
    'warn() { :; }',
    'ok() { :; }',
    body[0],
    'refresh_hook_entries 900',
  ].join('\n')
  const script = join(mkdtempSync(join(tmpdir(), 'hoai-routing-')), 'run.sh')
  writeFileSync(script, harness)
  const out = spawnSync(bash, [bashPath(script)], { encoding: 'utf8', windowsHide: true })
  assert.equal(out.status, 0, `harness failed: ${out.stderr}`)
  return out.stdout
}

function folder(opts: { claudeDir: boolean; settings?: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'hoai-agent-'))
  if (opts.claudeDir) mkdirSync(join(root, '.claude'), { recursive: true })
  if (opts.settings !== undefined) {
    writeFileSync(join(root, '.claude', 'settings.local.json'), opts.settings)
  }
  return root
}

test('1. a workspace with the activity rail gets BOTH the deny and the hooks', (t) => {
  const wd = folder({
    claudeDir: true,
    settings: JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', args: ['/x/hoai-hook.mjs'] }] }] },
    }),
  })
  const out = runRefresh(t, wd)
  if (out === null) return
  assert.match(out, /RAN:deny/)
  assert.match(out, /RAN:hooks/)
})

test('2. THE CASE THIS CHANGE EXISTS FOR: settings with no hoai-hook gets the deny and NOT the hooks', (t) => {
  // A workspace that gets its hooks elsewhere. The old code did nothing here,
  // so an agent in this shape never received the deny.
  const wd = folder({ claudeDir: true, settings: JSON.stringify({ permissions: { allow: [] } }) })
  const out = runRefresh(t, wd)
  if (out === null) return
  assert.match(out, /RAN:deny/, 'the deny must not inherit the hooks gate')
  assert.doesNotMatch(out, /RAN:hooks/, 'the hooks gate must still hold')
})

test('3. a .claude directory with no settings file at all still gets the deny', (t) => {
  // Eight of the nine agents measured on 2026-10-02 were in this shape or had
  // no .claude at all.
  const wd = folder({ claudeDir: true })
  const out = runRefresh(t, wd)
  if (out === null) return
  assert.match(out, /RAN:deny/)
  assert.doesNotMatch(out, /RAN:hooks/)
})

test('4. a workdir with no .claude directory is left completely alone', (t) => {
  // A restart never invents configuration for a folder that has none.
  const out = runRefresh(t, folder({ claudeDir: false }))
  if (out === null) return
  assert.doesNotMatch(out, /RAN:deny/)
  assert.doesNotMatch(out, /RAN:hooks/)
})
