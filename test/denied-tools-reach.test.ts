// `ensureDeniedTools` puts the terminal-only tool deny into an agent folder's
// settings.local.json, including a folder that ALREADY EXISTS, which is the
// whole point of the function (board row 01a07b28).
//
// THE DEFECT THIS GUARDS. Both bootstraps write this deny, and a bootstrap
// runs once, at first install. Every agent installed before the deny existed
// therefore never received it, and nothing revisited them: measured on a nine
// agent machine on 2026-10-02, ONE carried it. The fix has to land on a path
// an EXISTING agent takes, which is install and restart.
//
// AND WHY IT IS NOT FOLDED INTO ensureHookEntries, which writes the same file.
// `bgos-agent`'s restart path calls that function only when the settings file
// already names hoai-hook.mjs, because stacking a second hook entry on a
// workspace that gets its hooks elsewhere leaves a dead one firing. A
// permission cannot duplicate anything, so it must not inherit that gate. The
// "already has hooks, still gains the deny" case below is that distinction.
//
// Real files in a temp dir, because the thing under test is what ends up on
// disk.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DENIED_TOOLS, ensureDeniedTools } from '../lib/claude-preseed.mjs'

function agentFolder() {
  const root = mkdtempSync(join(tmpdir(), 'hoai-deny-'))
  mkdirSync(join(root, '.claude'), { recursive: true })
  return { root, settingsPath: join(root, '.claude', 'settings.local.json') }
}

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

test('DENIED_TOOLS names AskUserQuestion and is frozen', () => {
  assert.ok(DENIED_TOOLS.includes('AskUserQuestion'))
  assert.ok(Object.isFrozen(DENIED_TOOLS))
})

test('a folder with no settings file gets one carrying the deny', () => {
  const { settingsPath } = agentFolder()
  const result = ensureDeniedTools({ settingsPath })
  assert.equal(result.changed, true)
  assert.equal(result.reason, 'set')
  assert.deepEqual(read(settingsPath).permissions.deny, ['AskUserQuestion'])
})

test('THE REGRESSION CASE: a folder that already has hooks and no deny still gains it', () => {
  // This is the shape every pre-existing agent is in, and the shape that a
  // deny folded into ensureHookEntries would have skipped, because that
  // function short circuits on "my hook entries are already in place".
  const { settingsPath } = agentFolder()
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node', args: ['/x/hoai-hook.mjs'] }] }] },
    }),
  )
  const result = ensureDeniedTools({ settingsPath })
  assert.equal(result.changed, true)
  const after = read(settingsPath)
  assert.deepEqual(after.permissions.deny, ['AskUserQuestion'])
  // the hooks it already had are untouched
  assert.ok(Array.isArray(after.hooks.PreToolUse))
  assert.equal(after.hooks.PreToolUse[0].hooks[0].args[0], '/x/hoai-hook.mjs')
})

test('idempotent: a second call reports already and changes no bytes', () => {
  const { settingsPath } = agentFolder()
  ensureDeniedTools({ settingsPath })
  const first = readFileSync(settingsPath, 'utf8')
  const again = ensureDeniedTools({ settingsPath })
  assert.equal(again.changed, false)
  assert.equal(again.reason, 'already')
  assert.equal(readFileSync(settingsPath, 'utf8'), first)
})

test('it keeps every other permission key and every deny entry somebody else wrote', () => {
  const { settingsPath } = agentFolder()
  writeFileSync(
    settingsPath,
    JSON.stringify({
      permissions: {
        allow: ['Bash(ls:*)'],
        ask: ['WebFetch'],
        defaultMode: 'acceptEdits',
        deny: ['SomeOtherTool'],
      },
      unrelatedTopLevelKey: { kept: true },
    }),
  )
  ensureDeniedTools({ settingsPath })
  const after = read(settingsPath)
  assert.deepEqual(after.permissions.allow, ['Bash(ls:*)'])
  assert.deepEqual(after.permissions.ask, ['WebFetch'])
  assert.equal(after.permissions.defaultMode, 'acceptEdits')
  assert.deepEqual(after.permissions.deny, ['SomeOtherTool', 'AskUserQuestion'])
  assert.deepEqual(after.unrelatedTopLevelKey, { kept: true })
})

test('a settings file that does not parse is left exactly as it was', () => {
  // Guessing at a broken settings file is worse than leaving one tool allowed.
  const { settingsPath } = agentFolder()
  const garbage = '{ this is not json'
  writeFileSync(settingsPath, garbage)
  const result = ensureDeniedTools({ settingsPath })
  assert.equal(result.changed, false)
  assert.equal(result.reason, 'unparseable')
  assert.equal(readFileSync(settingsPath, 'utf8'), garbage)
})

test('settingsPath is required rather than silently defaulted', () => {
  assert.throws(() => ensureDeniedTools({ settingsPath: '' }), /settingsPath is required/)
})

// DRIFT GUARD. The bootstraps cannot import this library: they inline the same
// JS in a heredoc and a here-string, and they run BEFORE the plugin checkout is
// guaranteed to be in place, which is what bootstrapping means. So one shared
// source is not available to them, and the next best thing is that they cannot
// silently disagree with it. If DENIED_TOOLS ever gains a tool, this fails
// until both bootstraps gain it too.
test('both bootstraps deny exactly the tools DENIED_TOOLS names', () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  for (const script of ['hoai-bootstrap.sh', 'hoai-bootstrap.ps1']) {
    const text = readFileSync(join(here, '..', 'bin', script), 'utf8')
    for (const tool of DENIED_TOOLS) {
      assert.ok(
        text.includes(`"${tool}"`) || text.includes(`'${tool}'`),
        `${script} does not deny ${tool}, which lib/claude-preseed.mjs does`,
      )
    }
  }
})
