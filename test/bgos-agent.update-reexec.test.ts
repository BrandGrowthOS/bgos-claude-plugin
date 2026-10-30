/**
 * `bgos-agent update` pulls with `git reset --hard`, which REPLACES the script
 * that is running. The shell had already read the old function bodies, so the
 * rest of the update (the hook registration 0.67.2 added, the restart) ran as
 * it was before the pull: on KC's Mac the first update to 0.67.2 registered
 * nothing and a second run did (board bbbf3438 follow-up, 2026-10-12).
 *
 * This runs the REAL bin/bgos-agent against a local bare "origin": the checkout
 * starts with the current script, origin holds the same script with one extra
 * line that only the NEW file has. The line is printed at the end of
 * cmd_update. If the update does not hand over to the new file after the pull,
 * that line never prints.
 *
 * The agents' service names carry the HOME id (board row d6198bb6), which the
 * update computes with bin/hoai-agent-service.mjs on bun or node. When neither
 * answers, the update has still succeeded: it completes, restarts no service by
 * any name, and says for each agent why it was not restarted.
 *
 * Run: npx tsx --test test/bgos-agent.update-reexec.test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolvePosixBash } from './helpers/posix-bash.ts'
import { startManifestServer, type ManifestServer } from './helpers/manifest-server.ts'
import { watcherHomeId } from '../lib/watcher-service.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASH = process.platform === 'win32' ? null : resolvePosixBash()
const probe = (script: string) => (BASH ? spawnSync(BASH, ['-c', script], { encoding: 'utf8' }) : null)
const hasGit = probe('command -v git')?.status === 0
const hasNode = probe('command -v node')?.status === 0
const SKIP = BASH && hasGit && hasNode ? false : 'needs bash, git and node'

const NEW_MARKER = 'NEW-SCRIPT-RAN-THE-REST-OF-UPDATE'

// The update follows the PUBLISHED release (board row 01a0db74): origin's 2.0.0 is tagged v2.0.0, and this
// stand in for the marketplace names it, so the update moves exactly as it did when it followed main.
let marketplace: ManifestServer | null = null
before(async () => {
  if (!SKIP) marketplace = await startManifestServer('v2.0.0')
})
after(() => marketplace?.stop())
const published = () => ({ HOAI_PUBLISHED_MANIFEST_URL: marketplace!.url })

function sh(cwd: string, cmd: string, env: Record<string, string> = {}) {
  const res = spawnSync(BASH!, ['-c', cmd], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(res.status, 0, `${cmd}\n${res.stdout}\n${res.stderr}`)
  return res.stdout
}

/** A checkout whose origin has a newer commit that carries the NEW script. */
function fixture(scriptForCheckout: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'reexec-')))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const stubs = join(root, 'stubs')
  mkdirSync(stubs)
  // bun: `-e <script> <args>` is node's `-e` with the same argv shape; anything else is a no-op
  // (bun install, running the daemon wrapper), because there is no network and no daemon here.
  writeFileSync(
    join(stubs, 'bun'),
    '#!/bin/bash\nif [ "$1" = "-e" ]; then shift; s="$1"; shift; exec node -e "$s" -- "$@"; fi\nexit 0\n',
  )
  chmodSync(join(stubs, 'bun'), 0o755)

  const work = join(root, 'work')
  mkdirSync(join(work, 'bin'), { recursive: true })
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'hoai', version: '1.0.0' }))
  writeFileSync(join(work, 'bin', 'bgos-daemon-wrapper.mjs'), '// stub\n')
  // Every agent service name carries the HOME id (board row d6198bb6), which the update computes
  // before it looks for installed agents, with bin/hoai-agent-service.mjs and the lib it imports
  // (on bun or node: the bun stub prints nothing for it, so the node on PATH answers). A plugin
  // checkout carries both.
  cpSync(join(repoRoot, 'bin', 'hoai-agent-service.mjs'), join(work, 'bin', 'hoai-agent-service.mjs'))
  // What the update asks which release is published (board row 01a0db74), and what its lib imports from bin.
  cpSync(join(repoRoot, 'bin', 'hoai-published-release.mjs'), join(work, 'bin', 'hoai-published-release.mjs'))
  cpSync(join(repoRoot, 'bin', 'bgos-install-method.mjs'), join(work, 'bin', 'bgos-install-method.mjs'))
  cpSync(join(repoRoot, 'lib'), join(work, 'lib'), { recursive: true })
  const git = (c: string) => sh(work, `git ${c}`, { HOME: home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })
  git('init -q -b main')
  writeFileSync(join(work, 'bin', 'bgos-agent'), scriptForCheckout)
  chmodSync(join(work, 'bin', 'bgos-agent'), 0o755)
  git('add -A')
  git('commit -q -m v1')
  const origin = join(root, 'origin.git')
  sh(root, `git clone -q --bare "${work}" "${origin}"`, { HOME: home })
  git(`remote add origin "${origin}"`)
  git('fetch -q origin main')
  git('branch -q --set-upstream-to=origin/main main')

  // origin moves on: a new version, and the NEW script with a line only it has.
  const next = join(root, 'next')
  sh(root, `git clone -q "${origin}" "${next}"`, { HOME: home })
  const newScript = readFileSync(join(repoRoot, 'bin', 'bgos-agent'), 'utf8').replace(
    '\n  if [ "$installed" -eq 0 ]; then\n',
    `\n  echo "${NEW_MARKER}"\n  if [ "$installed" -eq 0 ]; then\n`,
  )
  assert.ok(newScript.includes(NEW_MARKER), 'the marker was injected into cmd_update')
  writeFileSync(join(next, 'bin', 'bgos-agent'), newScript)
  writeFileSync(join(next, 'package.json'), JSON.stringify({ name: 'hoai', version: '2.0.0' }))
  const gitNext = (c: string) => sh(next, `git ${c}`, { HOME: home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })
  gitNext('add -A')
  gitNext('commit -q -m v2')
  gitNext('tag v2.0.0')
  gitNext('push -q origin main refs/tags/v2.0.0')
  return { work, home, stubs }
}

function update(f: { work: string; home: string; stubs: string }) {
  return spawnSync(BASH!, [join(f.work, 'bin', 'bgos-agent'), 'update'], {
    cwd: f.work,
    encoding: 'utf8',
    env: { ...process.env, HOME: f.home, PATH: `${f.stubs}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: join(f.home, '.claude'), ...published() },
  })
}

test('the rest of the update runs the NEW script, and the version message still names where it started', { skip: SKIP }, () => {
  const current = readFileSync(join(repoRoot, 'bin', 'bgos-agent'), 'utf8')
  const f = fixture(current)
  const res = update(f)
  const out = `${res.stdout}\n${res.stderr}`
  assert.equal(res.status, 0, out)
  assert.match(out, new RegExp(NEW_MARKER), 'a line only the new file has was printed')
  assert.match(out, /plugin updated: 1\.0\.0 -> 2\.0\.0/)
  assert.equal((out.match(/Following the published release/g) ?? []).length, 1, 'the move happens once')
})

test('the hand-over is not a loop: an update that is already the re-executed one does not exec again', { skip: SKIP }, () => {
  const current = readFileSync(join(repoRoot, 'bin', 'bgos-agent'), 'utf8')
  const f = fixture(current)
  const res = spawnSync(BASH!, [join(f.work, 'bin', 'bgos-agent'), 'update'], {
    cwd: f.work,
    encoding: 'utf8',
    env: { ...process.env, HOME: f.home, PATH: `${f.stubs}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: join(f.home, '.claude'), ...published(), HOAI_UPDATE_REEXEC: '1', HOAI_UPDATE_FROM_VERSION: '0.9.0' },
  })
  const out = `${res.stdout}\n${res.stderr}`
  assert.equal(res.status, 0, out)
  assert.doesNotMatch(out, /Following the published release/, 'the flag says the move is done')
  assert.match(out, /0\.9\.0 -> 1\.0\.0/, 'the starting version comes from the environment')
})

test('an update whose HOME id helper cannot answer still completes: it restarts nothing by name and says why, for each agent', { skip: SKIP }, () => {
  const current = readFileSync(join(repoRoot, 'bin', 'bgos-agent'), 'utf8')
  const OS = process.platform === 'darwin' ? 'Darwin' : 'Linux'
  // [name, argv, is agent 42's service file the one named after this HOME (renamed) or its OLD one]
  const legs: Array<[string, string[], boolean]> = [
    // Every agent: an OLD (0.69.2) service file of this HOME, an agent not renamed yet.
    ['all agents, an agent not renamed yet', ['update'], false],
    // Every agent: only the file under this HOME's own name, an agent already renamed. With no HOME id
    // its name cannot be computed, but the file is still found (by its home-<hid> pattern), so the
    // update says why it was not restarted rather than that no agent service is installed.
    ['all agents, an agent already renamed', ['update'], true],
    // One agent by id: its service under this HOME's own name.
    ['one agent by id, its service under this HOME\'s name', ['update', '--assistant', '42'], true],
  ]
  for (const [name, args, renamed] of legs) {
    const f = fixture(current)
    // Neither runtime answers bin/hoai-agent-service.mjs (the bun stub prints nothing for it; this
    // node fails on it, as a node too old for it does), so no HOME id: node runs everything else.
    writeFileSync(
      join(f.stubs, 'node'),
      `#!/bin/bash\ncase "$1" in *hoai-agent-service.mjs) echo "SyntaxError: Unexpected token '.'" >&2; exit 1 ;; esac\nexec '${process.execPath}' "$@"\n`,
    )
    chmodSync(join(f.stubs, 'node'), 0o755)
    // The service managers and tmux record every call and touch nothing real.
    const log = join(f.home, 'service-calls.log')
    for (const tool of ['launchctl', 'systemctl', 'loginctl', 'tmux']) {
      writeFileSync(join(f.stubs, tool), `#!/bin/sh\n{ printf '%s' '${tool}'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; } >> '${log}'\nexit 0\n`)
      chmodSync(join(f.stubs, tool), 0o755)
    }
    const state = join(f.home, '.bgos-agent', '42')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'run.sh'), '#!/bin/bash\n')
    const hid = watcherHomeId(f.home, OS === 'Darwin' ? 'darwin' : 'linux')
    assert.match(hid, /^[0-9a-f]{8}$/)
    const byId = args.includes('--assistant')
    const label = renamed ? `ai.bgos.agent.42.home-${hid}` : 'ai.bgos.agent.42'
    const unit = renamed ? `bgos-agent-42-home-${hid}` : 'bgos-agent-42'
    const file = OS === 'Darwin' ? join(f.home, 'Library', 'LaunchAgents', `${label}.plist`) : join(f.home, '.config', 'systemd', 'user', `${unit}.service`)
    const content =
      OS === 'Darwin'
        ? `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>/bin/bash</string>\n    <string>${state}/run.sh</string>\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>HOME</key><string>${f.home}</string>\n  </dict>\n</dict>\n</plist>\n`
        : `[Unit]\nDescription=BGOS Claude Code agent 42\n\n[Service]\nType=simple\nExecStart=/bin/bash "${state}/run.sh"\nEnvironment=HOME=${f.home}\n\n[Install]\nWantedBy=default.target\n`
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
    const res = spawnSync(BASH!, [join(f.work, 'bin', 'bgos-agent'), ...args], {
      cwd: f.work,
      encoding: 'utf8',
      env: { ...process.env, HOME: f.home, PATH: `${f.stubs}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: join(f.home, '.claude'), ...published() },
    })
    const out = `${res.stdout}\n${res.stderr}`
    assert.equal(res.status, 0, `${name}: the update itself completes\n${out}`)
    assert.match(out, /plugin updated: 1\.0\.0 -> 2\.0\.0/, name)
    // The all-agents loop ran to its end (the marker sits right after it); by id the update returns before it.
    if (byId) assert.doesNotMatch(out, new RegExp(NEW_MARKER), name)
    else assert.match(out, new RegExp(NEW_MARKER), `${name}: the rest of cmd_update ran to its end`)
    const why = `agent 42 was not restarted: its service is named after this HOME and the HOME id could not be computed (${f.work}/bin/hoai-agent-service.mjs runs on bun or node); quit and relaunch Claude Code`
    assert.equal(out.split('\n').filter((l) => l.includes('was not restarted')).map((l) => l.replace(/^.*?agent 42/, 'agent 42')).join('\n'), why, `${name}: says why, once`)
    assert.doesNotMatch(out, /restarted agent 42|could not restart agent 42|no installed agent services found|service-name:home-id-unavailable/, name)
    const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
    assert.deepEqual(calls, [], `${name}: no service or tmux command at all, so nothing restarted by any name`)
    assert.equal(readFileSync(file, 'utf8'), content, `${name}: the service file is left as it is`)
    if (renamed && !byId) {
      // `is-installed` with no HOME id finds the renamed file the same way (a file test): installed.
      const isInstalled = (id: string) =>
        spawnSync(BASH!, [join(f.work, 'bin', 'bgos-agent'), 'is-installed', '--assistant', id], {
          cwd: f.work,
          encoding: 'utf8',
          env: { ...process.env, HOME: f.home, PATH: `${f.stubs}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: join(f.home, '.claude'), ...published() },
        })
      const yes = isInstalled('42')
      assert.equal(yes.status, 0, `${name}: is-installed --assistant 42 sees the renamed service file\n${yes.stdout}\n${yes.stderr}`)
      // Nothing else makes it answer yes: an agent with no service file at all is not installed.
      const no = isInstalled('43')
      assert.equal(no.status, 1, `${name}: is-installed --assistant 43 (no service file)\n${no.stdout}\n${no.stderr}`)
      assert.deepEqual(existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [], [], `${name}: is-installed asks no service manager`)
      assert.equal(readFileSync(file, 'utf8'), content, name)
    }
  }
})
