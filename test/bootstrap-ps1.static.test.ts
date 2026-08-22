// Static invariants for bin/hoai-bootstrap.ps1 (and its sh sibling when it
// lands). The bootstrap cannot be unit-tested the way the .mjs engines are,
// so these tests pin the contract surface instead: the sentinel protocol, the
// exit-code table, the prompts it must pre-seed, and the characters it must
// never contain. The full behavior is exercised by the clean-env matrix runs.
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const ps1Path = join(repoRoot, 'bin', 'hoai-bootstrap.ps1')
const ps1 = readFileSync(ps1Path, 'utf8')

test('no em dashes or en dashes anywhere in the bootstrap', () => {
  assert.ok(!ps1.includes('—'), 'found an em dash')
  assert.ok(!ps1.includes('–'), 'found an en dash')
})

test('sentinel protocol: every step id is emitted, in order', () => {
  const ids = ['tools', 'claude-login', 'plugin', 'pair', 'preflight', 'launch', 'online']
  let last = -1
  for (const id of ids) {
    const at = ps1.indexOf(`'${id}'`)
    assert.ok(ps1.includes(`::hoa-step::`), 'step sentinel prefix present')
    assert.ok(at > -1, `step '${id}' emitted`)
    assert.ok(at > last, `step '${id}' appears after the previous step`)
    last = at
  }
  assert.ok(ps1.includes('::hoa-fail::'), 'fail sentinel present')
  assert.ok(ps1.includes('::hoa-workdir::'), 'workdir sentinel present')
})

test('exit-code table matches the shared one-click contract', () => {
  const expected: Record<string, number> = {
    'git-missing': 20,
    'claude-missing': 21,
    'bun-install': 22,
    'plugin-install': 24,
    'pair-failed': 25,
    'creds-missing': 27,
    'claude-apikey-auth': 28,
    'script-error': 29,
    'agent-id-missing': 31,
    'preflight-failed': 32,
    'login-timeout': 33,
    'node-install': 34,
    'channel-deaf': 35,
  }
  for (const [reason, code] of Object.entries(expected)) {
    const re = new RegExp(`'${reason}'\\s*=\\s*${code}\\b`)
    assert.ok(re.test(ps1), `exit code ${code} pinned for ${reason}`)
  }
})

test('pre-seeds every characterized one-time prompt', () => {
  // Findings from the 2026-08-22 fresh-config characterization:
  //   theme wizard        -> .claude.json hasCompletedOnboarding + theme
  //   trust dialog        -> projects[<cwd>].hasTrustDialogAccepted
  //   bypass warning      -> settings.json skipDangerousModePermissionPrompt
  //                          (its DEFAULT answer is exit, never blind-Enter it)
  assert.ok(ps1.includes('hasCompletedOnboarding'))
  assert.ok(ps1.includes('hasTrustDialogAccepted'))
  assert.ok(ps1.includes('skipDangerousModePermissionPrompt'))
})

test('pairing runs from the workspace and carries the assistant id', () => {
  assert.ok(/Push-Location \$Workdir/.test(ps1), 'pair runs with cwd = workspace (folder pin lands there)')
  assert.ok(ps1.includes('--assistant-id $AssistantId'), 'assistant id is never typed by hand')
})

test('preflight gates success: doctor --preflight runs before launch', () => {
  const preflightAt = ps1.indexOf('--preflight')
  const launchAt = ps1.indexOf("Step 'launch'")
  assert.ok(preflightAt > -1 && launchAt > -1 && preflightAt < launchAt)
  assert.ok(ps1.includes("Fail 'preflight-failed'"))
})

test('installs only the gaps: every installer branch is detection-guarded', () => {
  // Each install action must sit under a "-not (Has '<tool>')" guard.
  for (const tool of ['node', 'bun', 'claude']) {
    assert.ok(
      ps1.includes(`if (-not (Has '${tool}'))`),
      `${tool} install is guarded by detection`,
    )
  }
})

test('login gate polls auth status and never proceeds logged-out', () => {
  assert.ok(ps1.includes('claude auth status --json'))
  assert.ok(ps1.includes('claude auth login --claudeai'))
  assert.ok(ps1.includes("Fail 'login-timeout'"))
})

test('PowerShell 5.1 parses the script cleanly (win32 only)', (t) => {
  if (process.platform !== 'win32') {
    t.skip('powershell parser check runs on Windows')
    return
  }
  const check = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$errs = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('${ps1Path.replace(/'/g, "''")}', [ref]$null, [ref]$errs); if ($errs.Count -eq 0) { 'PARSE-OK' } else { $errs | ForEach-Object { $_.Message } }`,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  )
  assert.match(check.stdout, /PARSE-OK/, `parser errors: ${check.stdout} ${check.stderr}`)
})
