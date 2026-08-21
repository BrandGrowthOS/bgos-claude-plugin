// Static invariants for bin/hoai-bootstrap.sh, the macOS/Linux mirror of
// bin/hoai-bootstrap.ps1. Same rationale as bootstrap-ps1.static.test.ts:
// the bootstrap cannot be unit-tested the way the .mjs engines are, so these
// tests pin the contract surface instead: the sentinel protocol, the
// exit-code table, the prompts it must pre-seed, the detection guards, and
// the bun/bunx PATH fix the Mac mini defect taught us. The full behavior is
// exercised by the clean-env matrix runs.
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const shPath = join(repoRoot, 'bin', 'hoai-bootstrap.sh')
const sh = readFileSync(shPath, 'utf8')

test('no em dashes or en dashes anywhere in the bootstrap', () => {
  // Code points spelled numerically so this test file itself stays free of
  // the characters it bans (U+2014 em dash, U+2013 en dash).
  const emDash = String.fromCharCode(0x2014)
  const enDash = String.fromCharCode(0x2013)
  assert.ok(!sh.includes(emDash), 'found an em dash')
  assert.ok(!sh.includes(enDash), 'found an en dash')
})

test('sentinel protocol: every step id is emitted, in order', () => {
  const ids = ['tools', 'claude-login', 'plugin', 'pair', 'preflight', 'launch', 'online']
  let last = -1
  for (const id of ids) {
    const at = sh.indexOf(`step '${id}'`)
    assert.ok(sh.includes(`::hoa-step::`), 'step sentinel prefix present')
    assert.ok(at > -1, `step '${id}' emitted`)
    assert.ok(at > last, `step '${id}' appears after the previous step`)
    last = at
  }
  assert.ok(sh.includes('::hoa-fail::'), 'fail sentinel present')
  assert.ok(sh.includes('::hoa-workdir::'), 'workdir sentinel present')
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
  }
  for (const [reason, code] of Object.entries(expected)) {
    const re = new RegExp(`${reason}\\)\\s+echo ${code}\\b`)
    assert.ok(re.test(sh), `exit code ${code} pinned for ${reason}`)
  }
})

test('pre-seeds every characterized one-time prompt', () => {
  // Findings from the 2026-08-22 fresh-config characterization:
  //   theme wizard        -> .claude.json hasCompletedOnboarding + theme
  //   trust dialog        -> projects[<cwd>].hasTrustDialogAccepted
  //   bypass warning      -> settings.json skipDangerousModePermissionPrompt
  //                          (its DEFAULT answer is exit, never blind-Enter it)
  assert.ok(sh.includes('hasCompletedOnboarding'))
  assert.ok(sh.includes('hasTrustDialogAccepted'))
  assert.ok(sh.includes('skipDangerousModePermissionPrompt'))
})

test('pairing runs from the workspace and carries the assistant id', () => {
  assert.ok(
    sh.includes('cd "$WORKDIR" && node "$PLUGIN_ROOT/bin/bgos-pair.mjs"'),
    'pair runs with cwd = workspace (folder pin lands there)',
  )
  assert.ok(sh.includes('--assistant-id "$ASSISTANT_ID"'), 'assistant id is never typed by hand')
})

test('preflight gates success: doctor --preflight runs before launch', () => {
  const preflightAt = sh.indexOf('bgos-doctor.mjs" --preflight')
  const launchAt = sh.indexOf("step 'launch'")
  assert.ok(preflightAt > -1 && launchAt > -1 && preflightAt < launchAt)
  assert.ok(sh.includes("fail 'preflight-failed'"))
})

test('installs only the gaps: every installer branch is detection-guarded', () => {
  // Each install action must sit under a "! command -v <tool>" guard.
  for (const tool of ['node', 'bun', 'claude']) {
    assert.ok(
      sh.includes(`if ! command -v ${tool} >/dev/null 2>&1; then`),
      `${tool} install is guarded by detection`,
    )
  }
})

test('login gate polls auth status and never proceeds logged-out', () => {
  assert.ok(sh.includes('claude auth status --json'))
  assert.ok(sh.includes('claude auth login --claudeai'))
  assert.ok(sh.includes("fail 'login-timeout'"))
})

test('both bun and bunx land in ~/.local/bin (the Mac mini defect)', () => {
  const lnLines = sh.split('\n').filter((l) => l.includes('ln -sf'))
  assert.ok(
    lnLines.some((l) => l.includes('/bun"')),
    'bun symlinked into $HOME/.local/bin',
  )
  assert.ok(
    lnLines.some((l) => l.includes('/bunx"')),
    'bunx symlinked into $HOME/.local/bin',
  )
  assert.ok(sh.includes('command -v bun >/dev/null 2>&1 || fail'), 'bun verified after linking')
  assert.ok(sh.includes('command -v bunx >/dev/null 2>&1 || fail'), 'bunx verified after linking')
})

test('bash parses the script cleanly (bash -n)', (t) => {
  const check = spawnSync('bash', ['-n', shPath.replace(/\\/g, '/')], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (check.error && (check.error as NodeJS.ErrnoException).code === 'ENOENT') {
    t.skip('bash is not installed on this machine')
    return
  }
  assert.strictEqual(check.status, 0, `bash -n errors: ${check.stdout} ${check.stderr}`)
})
