// Both bootstraps deny Claude Code's own AskUserQuestion tool in the
// settings.json they manage (board row 01a07b28). A BGOS agent asks its owner
// through the HOAI app (ask_user_input), which reaches the owner wherever they
// are; Claude Code's built in AskUserQuestion stops the session at a terminal
// nobody is watching. This test runs the REAL pre-seed script each bootstrap
// embeds (the .sh heredoc and the .ps1 here-string) with node against a
// temporary config folder, so it proves what the file on disk ends up holding:
// the deny entry is added once, an existing deny list and every other key are
// kept, and a second run changes nothing.
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sh = readFileSync(join(repoRoot, 'bin', 'hoai-bootstrap.sh'), 'utf8').replace(/\r\n/g, '\n')
const ps1 = readFileSync(join(repoRoot, 'bin', 'hoai-bootstrap.ps1'), 'utf8').replace(/\r\n/g, '\n')

function between(text: string, open: string, close: string): string {
  const a = text.indexOf(open)
  assert.ok(a > -1, `found ${JSON.stringify(open)}`)
  const b = text.indexOf(close, a + open.length)
  assert.ok(b > -1, `found the end of the block after ${JSON.stringify(open)}`)
  return text.slice(a + open.length, b)
}

const SCRIPTS: Array<[string, string]> = [
  ['hoai-bootstrap.sh', between(sh, `cat > "$PRESEED_JS" <<'JS'\n`, '\nJS\n')],
  ['hoai-bootstrap.ps1', between(ps1, "$preseed = @'\n", "\n'@")],
]

function run(js: string, configDir: string) {
  const file = join(configDir, 'preseed.js')
  writeFileSync(file, js)
  const r = spawnSync(process.execPath, [file, configDir, join(configDir, 'work')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))
}

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-deny-'))
  try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

for (const [name, js] of SCRIPTS) {
  test(`${name}: with no settings.json, AskUserQuestion is denied (and the bypass prompt still skipped)`, () => {
    withDir((dir) => {
      const s = run(js, dir)
      assert.deepEqual(s.permissions?.deny, ['AskUserQuestion'])
      assert.equal(s.skipDangerousModePermissionPrompt, true)
    })
  })

  test(`${name}: an existing deny list and every other key are kept, the entry added once`, () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({
        model: 'opus',
        env: { A: '1' },
        permissions: { allow: ['Bash(ls:*)'], deny: ['WebFetch'], defaultMode: 'acceptEdits' },
      }))
      const s = run(js, dir)
      assert.equal(s.model, 'opus')
      assert.deepEqual(s.env, { A: '1' })
      assert.deepEqual(s.permissions.allow, ['Bash(ls:*)'])
      assert.equal(s.permissions.defaultMode, 'acceptEdits')
      assert.deepEqual(s.permissions.deny, ['WebFetch', 'AskUserQuestion'])
    })
  })

  test(`${name}: a list that already denies it is not doubled, and a second run changes nothing`, () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ permissions: { deny: ['AskUserQuestion', 'WebFetch'] } }))
      const first = run(js, dir)
      assert.deepEqual(first.permissions.deny, ['AskUserQuestion', 'WebFetch'])
      const second = run(js, dir)
      assert.deepEqual(second, first)
    })
  })
}
