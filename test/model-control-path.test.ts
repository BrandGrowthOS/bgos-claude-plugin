import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { installWrapper, planWrapperInstall } from '../lib/hoai-wrapper-install.mjs'
import { scratchDir } from './helpers/scratch-dirs.ts'
import { bashOrSkip } from './helpers/posix-bash.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const COMMAND = 'hoai-model-control'
const SOURCE = `${COMMAND}.mjs`
const POSIX = { skip: process.platform === 'win32' ? 'file links and the picker are supported on macOS and Linux' : false }

function write(path: string, content: string, executable = false) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { mode: executable ? 0o755 : 0o644 })
}

function plugin(root: string) {
  for (const file of ['bin/hoai', `bin/${SOURCE}`, 'lib/model-control-store.mjs']) {
    const dest = join(root, file)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(ROOT, file), dest)
  }
  // Installers must make a packaged source executable, even if its mode was lost.
  chmodSync(join(root, 'bin', SOURCE), 0o644)
  write(join(root, 'server.ts'), '// installed plugin fixture\n')
}

function status(home: string) {
  const result = spawnSync(COMMAND, ['status', '--assistant', 'example-agent'], {
    cwd: home, encoding: 'utf8', timeout: 10_000,
    env: {
      ...process.env, HOME: home, PATH: `${join(home, '.local/bin')}:${process.env.PATH}`,
      CLAUDE_CONFIG_DIR: join(home, '.claude'), BGOS_PLUGIN_STATE_DIR: join(home, 'state'),
    },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Remote model and effort control is off for agent example-agent/)
  assert.equal(existsSync(join(home, '.claude/settings.json')), false, 'installing and checking status do not opt an owner in')
}

for (const platform of ['darwin', 'linux']) {
  test(`CLI installer on ${platform} puts a runnable model command next to hoai`, POSIX, () => {
    const home = scratchDir('model-path-')
    const root = join(home, 'plugin with spaces')
    plugin(root)
    const result = installWrapper({ platform, home, pluginRoot: root, env: { PATH: '/usr/bin' } })
    assert.equal(result.ok, true, result.notes.join('; '))
    assert.equal(readlinkSync(join(home, '.local/bin', COMMAND)), join(root, 'bin', SOURCE))
    assert.equal(readlinkSync(join(home, '.local/bin/hoai')), join(root, 'bin/hoai'))
    status(home)
  })
}

for (const os of ['Darwin', 'Linux']) {
  for (const method of ['marketplace', 'clone']) {
    test(`one-click ${os} ${method} install and repeat install put the model command on PATH`, POSIX, (t) => {
      const bash = bashOrSkip(t)
      if (!bash) return
      const home = scratchDir('model-bootstrap-')
      const root = method === 'clone' ? join(home, 'bgos-claude-plugin') : join(home, '.claude/plugins/cache/hoai/hoai/1.0.0')
      plugin(root)
      const tools = join(home, 'tools')
      write(join(tools, 'bin/bgos-pair.mjs'), '// pairing is outside this installer contract\n')
      write(join(tools, 'bin/bgos-doctor.mjs'), '// preflight is outside this installer contract\n')
      const shims = join(home, 'shims')
      write(join(shims, 'uname'), `#!/bin/sh\nprintf '%s\\n' '${os}'\n`, true)
      write(join(shims, 'claude'), '#!/bin/sh\ncase "$1" in\n auth) printf \'{"loggedIn":true,"authMethod":"claude.ai"}\\n\';;\n *) exit 0;;\nesac\n', true)
      write(join(shims, 'bun'), '#!/bin/sh\nexit 0\n', true)
      write(join(shims, 'bunx'), '#!/bin/sh\nexit 0\n', true)
      // A network attempt is a fixture error, never an actual download.
      for (const name of ['curl', 'git']) write(join(shims, name), '#!/bin/sh\nexit 99\n', true)
      write(join(home, '.bashrc'), '# test profile\n')
      const temp = join(home, 'tmp')
      mkdirSync(temp)
      const run = () => {
        const result = spawnSync(bash, [join(ROOT, 'bin/hoai-bootstrap.sh'),
          '--pair-code', 'example-code', '--assistant-id', '123', '--backend', 'https://example.invalid/api/v1',
          '--install-method', method, '--tools-root', tools, '--no-launch', '--non-interactive'], {
          cwd: home, encoding: 'utf8', timeout: 20_000,
          env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
            TMPDIR: temp, PATH: `${shims}:${process.env.PATH}`, ANTHROPIC_API_KEY: '' },
        })
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
        assert.equal(readlinkSync(join(home, '.local/bin', COMMAND)), join(root, 'bin', SOURCE))
        assert.equal(readlinkSync(join(home, '.local/bin/hoai')), join(root, 'bin/hoai'))
      }
      run()
      run()
      assert.equal(readFileSync(join(home, '.bashrc'), 'utf8').match(/export PATH=/g)?.length, 1)
      status(home)
    })
  }
}

test('the legacy agent link command also installs the model command', POSIX, (t) => {
  const bash = bashOrSkip(t)
  if (!bash) return
  const home = scratchDir('model-agent-link-')
  const result = spawnSync(bash, [join(ROOT, 'bin/bgos-agent'), 'link'], {
    cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readlinkSync(join(home, '.local/bin', COMMAND)), join(ROOT, 'bin', SOURCE))
  status(home)
})

for (const kind of ['file', 'foreign-link', 'broken-link']) {
  test(`CLI installer preserves an existing model command owned elsewhere: ${kind}`, POSIX, () => {
    const home = scratchDir('model-path-guard-')
    const root = join(home, 'plugin')
    plugin(root)
    const link = join(home, '.local/bin', COMMAND)
    mkdirSync(dirname(link), { recursive: true })
    const other = join(home, 'another-install', SOURCE)
    if (kind === 'file') write(link, 'owner command\n')
    else {
      if (kind === 'foreign-link') write(other, 'owner command\n')
      symlinkSync(other, link)
    }
    const result = installWrapper({ home, pluginRoot: root, env: { PATH: '' } })
    assert.equal(result.ok, true)
    assert.equal(result.kept.length, 1)
    assert.equal(result.kept[0].path, link)
    if (kind === 'file') assert.equal(readFileSync(link, 'utf8'), 'owner command\n')
    else assert.equal(readlinkSync(link), other)
    const forced = installWrapper({ home, pluginRoot: root, env: { PATH: '' }, force: true })
    assert.equal(forced.ok, true)
    assert.equal(readlinkSync(link), join(root, 'bin', SOURCE))
  })
}

test('CLI installer refuses a missing model command source and avoids a self link', POSIX, () => {
  const home = scratchDir('model-path-source-')
  const root = join(home, '.local')
  plugin(root)
  const result = installWrapper({ home, pluginRoot: root, env: { PATH: '' } })
  assert.equal(result.ok, true)
  assert.ok(result.wrote.includes(join(root, 'bin', COMMAND)))
  rmSync(join(root, 'bin', SOURCE))
  const missing = installWrapper({ home, pluginRoot: root, env: { PATH: '' } })
  assert.equal(missing.ok, false)
  assert.ok(missing.notes.some((note: string) => note.includes(SOURCE)))
})

test('Windows installers keep the picker command out of their install plans', () => {
  const plan = planWrapperInstall({ platform: 'win32', home: 'C:\\Users\\owner', localAppData: 'C:\\Local', pluginRoot: 'C:\\plugin' })
  assert.equal(plan.ok, true)
  assert.equal(plan.entries.some((entry: { to: string }) => entry.to.includes(COMMAND)), false)
  const source = readFileSync(join(ROOT, 'bin/hoai-bootstrap.ps1'), 'utf8')
  assert.match(source, /foreach \(\$aliasFile in @\('hoai.ps1', 'hoai.cmd'\)\)/)
  assert.equal(/(?:Copy-Item|New-Item)[^\n]*hoai-model-control/.test(source), false)
})
