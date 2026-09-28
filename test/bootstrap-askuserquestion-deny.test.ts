// Both bootstraps deny Claude Code's own AskUserQuestion tool for the AGENT
// (board row 01a07b28). A BGOS agent asks its owner through the HOAI app
// (ask_user_input), which reaches the owner wherever they are; Claude Code's
// built in AskUserQuestion stops the session at a terminal nobody is watching.
//
// The deny belongs to the agent's folder, never to the owner. With
// CLAUDE_CONFIG_DIR unset the config dir both scripts pre-seed is
// $HOME/.claude, the owner's OWN settings.json, which every Claude Code session
// they run reads; a deny written there would switch AskUserQuestion off in all
// of their personal sessions. So the entry goes into the workspace's
// .claude/settings.local.json, the file the bootstrap already manages there
// (the activity hooks go into it too), and the owner's settings.json keeps
// only what it had plus the bypass prompt acceptance.
//
// This test runs the REAL pre-seed script each bootstrap embeds (the .sh
// heredoc and the .ps1 here-string) with node, against a temporary HOME whose
// .claude folder stands for the unset CLAUDE_CONFIG_DIR, so it proves what the
// files on disk end up holding.
import { test } from 'node:test'
import assert from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

// The config dir each script hands its pre-seed when CLAUDE_CONFIG_DIR is
// unset is the owner's own $HOME/.claude. Pinned here so the fake HOME below
// stands for exactly that case.
test('with CLAUDE_CONFIG_DIR unset, both scripts pre-seed $HOME/.claude (the owner\'s own folder)', () => {
  assert.match(sh, /^CONFIG_DIR="\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}"$/m)
  assert.match(sh, /node "\$PRESEED_JS" "\$CONFIG_DIR" "\$WORKDIR"/)
  assert.match(ps1, /^\$ClaudeConfigDir = \$env:CLAUDE_CONFIG_DIR$/m)
  assert.match(ps1, /^if \(-not \$ClaudeConfigDir\) \{ \$ClaudeConfigDir = Join-Path \$env:USERPROFILE '\.claude' \}$/m)
  assert.match(ps1, /& node \$preseedPath \$ClaudeConfigDir \$Workdir/)
})

type World = { home: string; configDir: string; workdir: string; userSettings: string; agentSettings: string }

function withWorld(fn: (w: World) => void) {
  const root = mkdtempSync(join(tmpdir(), 'hoai-deny-'))
  const home = join(root, 'home')
  const configDir = join(home, '.claude')
  const workdir = join(root, 'agent')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(workdir, { recursive: true })
  try {
    fn({
      home,
      configDir,
      workdir,
      userSettings: join(configDir, 'settings.json'),
      agentSettings: join(workdir, '.claude', 'settings.local.json'),
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function run(js: string, w: World) {
  const file = join(w.home, 'preseed.js')
  writeFileSync(file, js)
  const r = spawnSync(process.execPath, [file, w.configDir, w.workdir], {
    encoding: 'utf8',
    env: { ...process.env, HOME: w.home, USERPROFILE: w.home },
  })
  assert.equal(r.status, 0, r.stderr)
  return r
}

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

for (const [name, js] of SCRIPTS) {
  test(`${name}: the owner's own $HOME/.claude/settings.json is never given the deny, whatever it held`, () => {
    withWorld((w) => {
      writeFileSync(w.userSettings, JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Bash(ls:*)'], deny: ['WebFetch'], defaultMode: 'acceptEdits' },
      }))
      run(js, w)
      const user = readJson(w.userSettings)
      assert.deepEqual(user.permissions, { allow: ['Bash(ls:*)'], deny: ['WebFetch'], defaultMode: 'acceptEdits' })
      assert.equal(user.model, 'opus')
      assert.equal(user.skipDangerousModePermissionPrompt, true)
      assert.deepEqual(readJson(w.agentSettings).permissions.deny, ['AskUserQuestion'])
    })
  })

  test(`${name}: with no settings anywhere, the deny lands in the agent folder only, and the owner's file gains no permissions`, () => {
    withWorld((w) => {
      run(js, w)
      assert.deepEqual(readJson(w.agentSettings), { permissions: { deny: ['AskUserQuestion'] } })
      const user = readJson(w.userSettings)
      assert.equal(user.permissions, undefined)
      assert.equal(user.skipDangerousModePermissionPrompt, true)
    })
  })

  test(`${name}: the agent folder's existing settings (hooks, allow, deny, mode) are kept, the entry added once`, () => {
    withWorld((w) => {
      mkdirSync(join(w.workdir, '.claude'), { recursive: true })
      const hooks = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node', args: ['x.mjs'] }] }] }
      writeFileSync(w.agentSettings, JSON.stringify({
        hooks,
        permissions: { allow: ['Bash(ls:*)'], deny: ['WebFetch'], defaultMode: 'acceptEdits' },
      }))
      run(js, w)
      const s = readJson(w.agentSettings)
      assert.deepEqual(s.hooks, hooks)
      assert.deepEqual(s.permissions.allow, ['Bash(ls:*)'])
      assert.equal(s.permissions.defaultMode, 'acceptEdits')
      assert.deepEqual(s.permissions.deny, ['WebFetch', 'AskUserQuestion'])
    })
  })

  test(`${name}: a list that already denies it is not doubled, and a second run changes neither file`, () => {
    withWorld((w) => {
      mkdirSync(join(w.workdir, '.claude'), { recursive: true })
      writeFileSync(w.agentSettings, JSON.stringify({ permissions: { deny: ['AskUserQuestion', 'WebFetch'] } }))
      run(js, w)
      const first = [readFileSync(w.agentSettings, 'utf8'), readFileSync(w.userSettings, 'utf8')]
      assert.deepEqual(readJson(w.agentSettings).permissions.deny, ['AskUserQuestion', 'WebFetch'])
      run(js, w)
      assert.deepEqual([readFileSync(w.agentSettings, 'utf8'), readFileSync(w.userSettings, 'utf8')], first)
    })
  })

  test(`${name}: an agent settings file that does not parse is left byte for byte, and the run still succeeds`, () => {
    withWorld((w) => {
      mkdirSync(join(w.workdir, '.claude'), { recursive: true })
      const broken = '{ "permissions": { "deny": ["WebFetch"], '
      writeFileSync(w.agentSettings, broken)
      const r = run(js, w)
      assert.equal(readFileSync(w.agentSettings, 'utf8'), broken)
      assert.match(r.stdout, /does not parse/)
      assert.equal(readJson(w.userSettings).permissions, undefined)
    })
  })

  test(`${name}: the activity hook registration that follows keeps the deny (same file, run in the bootstrap's order)`, async () => {
    const { ensureHookEntries } = await import(pathToFileURL(join(repoRoot, 'lib', 'claude-preseed.mjs')).href)
    withWorld((w) => {
      run(js, w)
      ensureHookEntries({ settingsPath: w.agentSettings, forwarderPath: join(w.home, 'hoai-hook.mjs'), floorHookPath: null })
      const s = readJson(w.agentSettings)
      assert.deepEqual(s.permissions.deny, ['AskUserQuestion'])
      assert.ok(s.hooks && typeof s.hooks === 'object', 'the hooks were written beside it')
      assert.ok(!existsSync(join(w.home, '.claude', 'settings.local.json')), 'nothing written into the owner folder')
    })
  })
}
