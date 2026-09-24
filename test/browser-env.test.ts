/**
 * The environment Chrome and the browser host are started with is an
 * ALLOW-LIST (lib/browser-env.mjs), not a deny-list by name.
 *
 * The case that forced it: SSH_AUTH_SOCK is a live handle to the user's
 * ssh-agent, which signs for whoever reaches the socket, and its name says
 * nothing a name rule could catch. Chrome loads untrusted pages, so it must
 * never inherit such a handle. These tests import the REAL functions from the
 * files that use them (the host's chromeEnv, the supervisor's hostEnv), and
 * they check the mechanism, not a list of names: EVERY variable in the
 * fixture that is not on the allow-list must be gone, so a name added to the
 * fixture is covered without touching an assertion. And the things a process
 * needs (PATH, HOME) must positively survive, so returning nothing cannot
 * pass.
 *
 * A NAME ONLY TESTS A MATCHER IF IT EXERCISES IT. The allow-list matches the
 * locale family by pattern (LC_<letters>) and every other entry by exact
 * name, so the fixture carries the names a slip in either rule would let in:
 * the code-execution family (LD_PRELOAD and friends, which a one character
 * widening of the locale pattern admits), names that share a prefix with an
 * allowed one (a prefix slip admits them), and a boundary table for the
 * locale pattern itself. The mutations that prove it widen the PATTERN, not
 * the list.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromeEnv, resolveChromeExecutable } from '../bin/hoai-browser-host.mjs'
import { hostEnv, startBrowserHostSupervisor } from '../lib/browser-host-supervisor.ts'
import { resolveNodePath } from '../lib/watcher-install.mjs'
import { startFakeRelay } from './helpers/fake-browser-relay.ts'

/** A realistic daemon environment. Values are markers, never real secrets. */
const FIXTURE: Record<string, string> = {
  // What a process needs.
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/Users/kc',
  TMPDIR: '/var/folders/xy/T/',
  USER: 'kc',
  LOGNAME: 'kc',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  TZ: 'Asia/Dubai',
  // Handles and secrets whose NAMES say nothing a name rule would catch.
  SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.x/Listeners',
  GH_PAT: 'marker-gh-pat',
  ANTHROPIC_KEY: 'marker-anthropic',
  CLAUDE_CODE_SESSION_ID: 'marker-session',
  // Secrets a name rule does catch, and the daemon's own settings.
  AWS_SECRET_ACCESS_KEY: 'marker-aws',
  BGOS_API_KEY: 'marker-bgos',
  BGOS_BACKEND_URL: 'https://api.test/api/v1',
  CLAUDE_CODE_MESSAGING_TOKEN: 'marker-messaging',
  // Desktop session: only for a browser that is shown, on linux.
  DISPLAY: ':0',
  XAUTHORITY: '/home/kc/.Xauthority',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  XDG_RUNTIME_DIR: '/run/user/1000',
  // Host settings (only the host gets them).
  HOAI_BROWSER_EXECUTABLE: '/opt/chrome',
  HOAI_BROWSER_HOST_AGENTS: '900',
  NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
  // Code execution in the process that loads untrusted pages, and a proxy
  // pair that silently redirects every request the browser makes.
  LD_PRELOAD: '/tmp/evil.so',
  LD_LIBRARY_PATH: '/tmp/evil',
  DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
  DYLD_LIBRARY_PATH: '/tmp/evil',
  NODE_OPTIONS: '--require /tmp/evil.js',
  GIT_SSH_COMMAND: 'ssh -i /tmp/key',
  http_proxy: 'http://attacker:8080',
  HTTPS_PROXY: 'http://attacker:8080',
  // Names that share a prefix with an allowed one: only an exact match keeps
  // them out.
  HOMEBREW_PREFIX: '/opt/homebrew',
  LANGSMITH_ENDPOINT: 'https://example.test',
  TZDIR: '/tmp/zoneinfo',
  USERNAME: 'kc',
  TEMPLATE_DIR: '/tmp/templates',
  PATH_TRANSLATED: '/tmp/x',
}

const CHROME_ALLOWED = new Set(['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ'])
const HOST_ALLOWED = new Set([...CHROME_ALLOWED, 'HOAI_BROWSER_EXECUTABLE', 'HOAI_BROWSER_HOST_AGENTS', 'NODE_EXTRA_CA_CERTS'])

function assertOnly(out: Record<string, string>, allowed: Set<string>, what: string) {
  for (const name of Object.keys(FIXTURE)) {
    if (allowed.has(name)) continue
    assert.ok(!(name in out), `${what} must not receive ${name}`)
  }
  for (const name of Object.keys(out)) assert.ok(allowed.has(name), `${what} received ${name}, which is not on its allow-list`)
  assert.equal(out.PATH, FIXTURE.PATH, `${what} keeps PATH`)
  assert.equal(out.HOME, FIXTURE.HOME, `${what} keeps HOME`)
}

test('Chrome gets an allow-listed environment: no ssh-agent socket, no key or token of any name, but PATH and HOME', () => {
  for (const platform of ['darwin', 'linux']) {
    assertOnly(chromeEnv(FIXTURE, { platform, headed: false }), CHROME_ALLOWED, `headless Chrome on ${platform}`)
  }
  assertOnly(chromeEnv(FIXTURE, { platform: 'darwin', headed: true }), CHROME_ALLOWED, 'a shown Chrome on macOS')
})

test('the host gets an allow-listed environment from the daemon: its own settings, and still no ssh-agent socket or key', () => {
  for (const platform of ['darwin', 'linux']) assertOnly(hostEnv(FIXTURE, { platform }), HOST_ALLOWED, `the host on ${platform}`)
})

test('a shown Chrome on linux also gets the display and the session, a headless one does not', () => {
  const display = new Set(['DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'])
  assertOnly(chromeEnv(FIXTURE, { platform: 'linux', headed: true }), new Set([...CHROME_ALLOWED, ...display]), 'a shown Chrome on linux')
  const headless = chromeEnv(FIXTURE, { platform: 'linux', headed: false })
  for (const name of display) assert.ok(!(name in headless), `headless Chrome on linux must not receive ${name}`)
  // The host passes the display on only when it will show the browser.
  assert.ok(!('DBUS_SESSION_BUS_ADDRESS' in hostEnv(FIXTURE, { platform: 'linux' })))
  assert.equal(hostEnv({ ...FIXTURE, HOAI_BROWSER_HEADED: '1' }, { platform: 'linux' }).DISPLAY, ':0')
})

test('on windows the system folders pass, matched whatever their case', () => {
  const win = { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\kc', LOCALAPPDATA: 'C:\\Users\\kc\\AppData\\Local', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', SSH_AUTH_SOCK: '\\\\.\\pipe\\openssh-ssh-agent', GH_PAT: 'marker' }
  const out = chromeEnv(win, { platform: 'win32' })
  assert.deepEqual(Object.keys(out).sort(), ['LOCALAPPDATA', 'Path', 'ProgramFiles(x86)', 'SystemRoot', 'USERPROFILE'])
})

test('the locale family is exactly LC_ followed by letters: every near miss stays out, the real categories pass', () => {
  const mustPass = ['LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_TIME', 'LC_NUMERIC', 'LC_COLLATE', 'LC_MONETARY', 'LC_PAPER']
  const mustNot = ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LC_', 'LC', 'LCALL', 'LC_1', 'LC_ALL1', 'LC__ALL', 'LC_ALL_X', 'XLC_ALL', 'L_ALL', 'LANG_OVERRIDE', 'LOGNAMEX', 'LESSOPEN', 'LDFLAGS']
  const env: Record<string, string> = { PATH: '/usr/bin', HOME: '/h' }
  for (const n of [...mustPass, ...mustNot]) env[n] = 'x'
  for (const platform of ['darwin', 'linux', 'win32']) {
    const out = chromeEnv(env, { platform, headed: true })
    for (const n of mustPass) assert.ok(n in out, `${n} is a locale category and passes on ${platform}`)
    for (const n of mustNot) assert.ok(!(n in out), `${n} is not a locale category and must not reach Chrome on ${platform}`)
  }
})

test('anything else is the owner opting in by name, and even then a credential-looking name stays out', () => {
  const env = { ...FIXTURE, HTTPS_PROXY: 'http://proxy:3128', GITHUB_TOKEN: 'marker', HOAI_BROWSER_CHROME_ENV: 'HTTPS_PROXY, GITHUB_TOKEN' }
  const chrome = chromeEnv(env, { platform: 'darwin' })
  assert.equal(chrome.HTTPS_PROXY, 'http://proxy:3128')
  assert.ok(!('GITHUB_TOKEN' in chrome), 'the name rule is the second pass')
  assert.ok(!('SSH_AUTH_SOCK' in chrome))
  // The host carries the opted-in name so it can hand it on to Chrome.
  assert.equal(hostEnv(env, { platform: 'darwin' }).HTTPS_PROXY, 'http://proxy:3128')
})

// ── End to end: what the REAL Chrome process receives, through the daemon ──

const chrome = resolveChromeExecutable()
const nodePath = resolveNodePath({ env: process.env, platform: process.platform, execPath: process.execPath, exists: existsSync })
const e2eSkip = process.platform === 'win32' ? 'the recording wrapper is a shell script' : !chrome.path ? 'no Chrome or Chromium is installed' : !nodePath ? 'node is not on PATH' : false

test(
  'END TO END: the daemon starts the host, the host starts Chrome, and Chrome receives only the allow-list',
  { timeout: 120_000, skip: e2eSkip },
  async () => {
    if (e2eSkip) return // bun ignores the skip option; this is the same skip
    const dir = mkdtempSync(join(tmpdir(), 'bh-env-e2e-'))
    const home = join(dir, 'home')
    const dump = join(dir, 'chrome-env-names.txt')
    // Stands in front of the real Chrome: records the NAMES it was started
    // with, then becomes Chrome. The shell adds PWD, SHLVL and _ itself.
    const wrapper = join(dir, 'chrome-wrapper.sh')
    writeFileSync(wrapper, `#!/bin/sh\nenv | cut -d= -f1 | sort > '${dump}'\nexec '${chrome.path}' "$@"\n`)
    chmodSync(wrapper, 0o755)
    const relay = await startFakeRelay({ token: 'tok-env', admissible: [900] })
    const daemonEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SSH_AUTH_SOCK: join(dir, 'agent.sock'),
      GH_PAT: 'marker-gh-pat',
      ANTHROPIC_KEY: 'marker-anthropic',
      CLAUDE_CODE_SESSION_ID: 'marker-session',
      HOAI_BROWSER_EXECUTABLE: wrapper,
    }
    const sup = startBrowserHostSupervisor({
      env: daemonEnv,
      auth: { mode: 'pairing', complete: true, backendUrl: relay.backendUrl, pairingToken: 'tok-env', assistantId: '900' },
      agentRoot: join(home, '.bgos-agent'),
      hostScript: join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hoai-browser-host.mjs'),
      nodePath,
      log: () => {},
    })
    try {
      const sock = await relay.waitForHost(30_000)
      const { post } = await relay.rpc(sock, { assistantId: 900, clientId: 'c', message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'about:blank' } } } }, 90_000)
      assert.equal(post?.body?.ok, true, JSON.stringify(post?.body))
      assert.ok(existsSync(dump), 'Chrome was started through the recording wrapper')
      const names = readFileSync(dump, 'utf8').split('\n').filter(Boolean)
      const shellOwn = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])
      for (const n of names) {
        if (shellOwn.has(n)) continue
        assert.ok(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'TZ'].includes(n) || /^LC_[A-Z]+$/.test(n), `Chrome was started with ${n}, which is not on the allow-list`)
      }
      for (const n of ['SSH_AUTH_SOCK', 'GH_PAT', 'ANTHROPIC_KEY', 'CLAUDE_CODE_SESSION_ID', 'HOAI_BROWSER_HOST_PAIRING_TOKEN', 'HOAI_BROWSER_EXECUTABLE']) {
        assert.ok(!names.includes(n), `Chrome must not receive ${n}`)
      }
      assert.ok(names.includes('PATH') && names.includes('HOME'), 'and it still has PATH and HOME')
      // The host itself, as the daemon started it: no ssh-agent socket either.
      const hostEnvText =
        process.platform === 'linux'
          ? readFileSync(`/proc/${sup.child!.pid}/environ`, 'utf8').split('\0').join('\n')
          : spawnSync('ps', ['eww', '-o', 'command=', '-p', String(sup.child!.pid)], { encoding: 'utf8' }).stdout
      assert.ok(!hostEnvText.includes('SSH_AUTH_SOCK='), 'the host was started without the ssh-agent socket')
      assert.ok(!hostEnvText.includes('marker-gh-pat') && !hostEnvText.includes('marker-anthropic'))
    } finally {
      sup.stop()
      await relay.close()
    }
  },
)
