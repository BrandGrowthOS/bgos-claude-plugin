/**
 * hoai-wrapper-install tests: putting the `hoai` command itself on PATH.
 *
 * KC's ask, 2026-08-25, was that the one word be typeable without npx. The
 * one-click bootstrap already installed the shim; `hoai setup <CODE>`, the
 * line the app hands out, did not, so a machine onboarded from the app had the
 * plugin installed, the agent paired, and no `hoai` to type.
 *
 * The load-bearing property here is NEGATIVE, so it is pinned first and hardest:
 * nothing in this module may write a shell alias, and nothing may write a
 * channel spec. A machine on this fleet carries
 *   alias hoai='claude --resume ... --dangerously-load-development-channels server:bgos'
 * in its .zshrc, and on a marketplace install that spec matches nothing and
 * every inbound message is dropped in silence (2026-08-21). The right flag is
 * knowable only at run time, so it is resolved on every launch and can never be
 * frozen into a string a shell expands.
 *
 * Every effect is injected, so no test touches a real home on any platform.
 *
 * Run: npm test, or npx tsx --test test/hoai-wrapper-install.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  POSIX_PROFILE_FILES,
  PROFILE_PATH_LINE,
  WIN_WRAPPER_FILES,
  WRAPPER_BREADCRUMB_FILE,
  installWrapper,
  inspectExistingShim,
  pathContainsDir,
  planWrapperInstall,
  profileNeedsPathLine,
  profilePathBlock,
  wrapperBinDir,
} from '../lib/hoai-wrapper-install.mjs'

const POSIX_HOME = '/home/kc'
const WIN_HOME = 'C:\\Users\\x'
const WIN_LOCAL_APP_DATA = 'C:\\Users\\x\\AppData\\Local'
const CLONE_ROOT = '/home/kc/bgos-claude-plugin'
const MARKETPLACE_ROOT_WIN = 'C:\\Users\\x\\.claude\\plugins\\cache\\hoai\\hoai\\0.38.3'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A fake filesystem: every path this test pretends exists, plus a record of
 *  everything the installer wrote, copied, linked or appended. */
function fakeFs(present: string[] = []) {
  const exists = new Set(present)
  const written = new Map<string, string>()
  const copied: { from: string; to: string }[] = []
  const linked: { target: string; link: string }[] = []
  const appended: { path: string; content: string }[] = []
  const files = new Map<string, string>()
  return {
    exists,
    written,
    copied,
    linked,
    appended,
    files,
    effects: {
      exists: (path: string) => exists.has(path),
      readFile: (path: string) => files.get(path) ?? null,
      writeFile: (path: string, content: string) => {
        written.set(path, content)
        return true
      },
      appendFile: (path: string, content: string) => {
        appended.push({ path, content })
        return true
      },
      mkdirp: () => true,
      copyFile: (from: string, to: string) => {
        copied.push({ from, to })
        return true
      },
      symlink: (target: string, link: string) => {
        linked.push({ target, link })
        return true
      },
      readlink: () => null,
      chmodX: () => true,
    },
  }
}

// -- The negative property (why this module exists at all) --------------------

test('the module NEVER emits a shell alias or a channel spec, not even in a comment it could print', () => {
  const source = readFileSync(join(repoRoot, 'lib', 'hoai-wrapper-install.mjs'), 'utf8')
  // A channel spec frozen into an alias is the 2026-08-21 silent-drop incident.
  // The one literal below is inside a comment describing that bad state; what
  // must never exist is a WRITE of one, so pin the writable surface instead:
  // no string this module can put in a file may contain a channel flag.
  for (const emitted of [PROFILE_PATH_LINE, profilePathBlock()]) {
    assert.equal(/alias\s+hoai\s*=/.test(emitted), false, 'no alias is ever written')
    assert.equal(/--dangerously-load-development-channels/.test(emitted), false)
    assert.equal(/server:bgos|plugin:hoai@hoai/.test(emitted), false)
  }
  // The profile writer only ever adds a PATH entry.
  assert.equal(PROFILE_PATH_LINE, 'export PATH="$HOME/.local/bin:$PATH"')
  // Belt and braces on the source: exactly one `alias hoai=` may appear, and it
  // must be inside a comment line, never in an assignment or a template.
  const aliasLines = source.split('\n').filter((line) => /alias\s+hoai\s*=/.test(line))
  assert.equal(aliasLines.length, 1, 'only the explanatory comment mentions an alias')
  assert.match(aliasLines[0]!.trim(), /^\*/, 'and it is a comment line')
})

test('an install writes no alias line into any profile, on any platform', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const fs = fakeFs([
      `${CLONE_ROOT}/bin/hoai`,
      ...WIN_WRAPPER_FILES.map((name) => `${MARKETPLACE_ROOT_WIN}\\bin\\${name}`),
    ])
    fs.files.set(`${POSIX_HOME}/.zshrc`, '# empty\n')
    installWrapper({
      pluginRoot: platform === 'win32' ? MARKETPLACE_ROOT_WIN : CLONE_ROOT,
      platform,
      home: platform === 'win32' ? WIN_HOME : POSIX_HOME,
      env: { LOCALAPPDATA: WIN_LOCAL_APP_DATA, PATH: '' },
      effects: fs.effects,
      runPathHelper: () => true,
    })
    const everythingWritten = [
      ...fs.written.values(),
      ...fs.appended.map((entry) => entry.content),
    ].join('\n')
    assert.equal(/alias/.test(everythingWritten), false, `${platform} wrote no alias`)
    assert.equal(
      /--dangerously-load-development-channels|server:bgos|plugin:hoai@hoai/.test(everythingWritten),
      false,
      `${platform} wrote no channel spec`,
    )
  }
})

// -- Where the shim goes ------------------------------------------------------

test('wrapperBinDir: the SAME locations the bootstrap and update-executor already use', () => {
  // posix: ~/.local/bin, mirror of hoai-bootstrap.sh LOCAL_BIN and
  // update-executor.mjs aliasSymlinkPath, so a one-click update re-points the
  // very shim this installs rather than leaving a second one behind.
  assert.equal(wrapperBinDir({ platform: 'linux', home: POSIX_HOME }), '/home/kc/.local/bin')
  assert.equal(wrapperBinDir({ platform: 'darwin', home: POSIX_HOME }), '/home/kc/.local/bin')
  // win32: %LOCALAPPDATA%\hoai\bin, mirror of hoai-bootstrap.ps1 $HoaiBin and
  // update-executor.mjs aliasBreadcrumbPath.
  assert.equal(
    wrapperBinDir({ platform: 'win32', home: WIN_HOME, localAppData: WIN_LOCAL_APP_DATA }),
    'C:\\Users\\x\\AppData\\Local\\hoai\\bin',
  )
  // No LOCALAPPDATA is the one case with no honest answer.
  assert.equal(wrapperBinDir({ platform: 'win32', home: WIN_HOME, localAppData: null }), '')
})

test('planWrapperInstall: posix is one symlink, win32 is two shims plus the breadcrumb', () => {
  const posix = planWrapperInstall({ platform: 'linux', home: POSIX_HOME, pluginRoot: CLONE_ROOT })
  assert.equal(posix.ok, true)
  assert.deepEqual(posix.ok && posix.entries, [
    { kind: 'symlink', from: `${CLONE_ROOT}/bin/hoai`, to: '/home/kc/.local/bin/hoai' },
  ])

  const win = planWrapperInstall({
    platform: 'win32',
    home: WIN_HOME,
    localAppData: WIN_LOCAL_APP_DATA,
    pluginRoot: MARKETPLACE_ROOT_WIN,
  })
  assert.equal(win.ok, true)
  const entries = win.ok ? win.entries : []
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ['copy', 'copy', 'breadcrumb'],
  )
  // The Windows shims are COPIES, so they cannot find hoai-core.mjs by their
  // own location; the breadcrumb is the only thing that makes them work.
  assert.equal(
    entries[2]!.to,
    `C:\\Users\\x\\AppData\\Local\\hoai\\bin\\${WRAPPER_BREADCRUMB_FILE}`,
  )
  assert.equal(entries[2]!.from, MARKETPLACE_ROOT_WIN)
})

test('planWrapperInstall: refuses rather than pointing a shim at nothing', () => {
  assert.equal(planWrapperInstall({ platform: 'linux', home: POSIX_HOME, pluginRoot: '' }).ok, false)
  assert.equal(
    planWrapperInstall({ platform: 'win32', home: WIN_HOME, localAppData: null, pluginRoot: MARKETPLACE_ROOT_WIN }).ok,
    false,
  )
})

// -- The install --------------------------------------------------------------

test('installWrapper on posix: symlinks ~/.local/bin/hoai at the plugin bin', () => {
  const fs = fakeFs([`${CLONE_ROOT}/bin/hoai`])
  fs.files.set(`${POSIX_HOME}/.zshrc`, '# nothing here yet\n')
  const result = installWrapper({
    pluginRoot: CLONE_ROOT,
    platform: 'linux',
    home: POSIX_HOME,
    env: { PATH: '/usr/bin' },
    effects: fs.effects,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(fs.linked, [
    { target: `${CLONE_ROOT}/bin/hoai`, link: '/home/kc/.local/bin/hoai' },
  ])
  // And the PATH line lands in the profile, byte identical to the bootstrap's.
  assert.deepEqual(
    fs.appended.map((entry) => entry.path),
    [`${POSIX_HOME}/.zshrc`],
  )
  assert.ok(fs.appended[0]!.content.includes(PROFILE_PATH_LINE))
})

test('installWrapper on win32: copies both shims, writes the breadcrumb, asks for the User PATH', () => {
  const fs = fakeFs(WIN_WRAPPER_FILES.map((name) => `${MARKETPLACE_ROOT_WIN}\\bin\\${name}`))
  const pathCalls: string[] = []
  const result = installWrapper({
    pluginRoot: MARKETPLACE_ROOT_WIN,
    platform: 'win32',
    home: WIN_HOME,
    env: { LOCALAPPDATA: WIN_LOCAL_APP_DATA, PATH: 'C:\\Windows' },
    effects: fs.effects,
    runPathHelper: (dir: string) => {
      pathCalls.push(dir)
      return true
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(
    fs.copied.map((entry) => entry.to),
    [
      'C:\\Users\\x\\AppData\\Local\\hoai\\bin\\hoai.ps1',
      'C:\\Users\\x\\AppData\\Local\\hoai\\bin\\hoai.cmd',
    ],
  )
  assert.equal(
    fs.written.get(`C:\\Users\\x\\AppData\\Local\\hoai\\bin\\${WRAPPER_BREADCRUMB_FILE}`),
    `${MARKETPLACE_ROOT_WIN}\n`,
  )
  assert.deepEqual(pathCalls, ['C:\\Users\\x\\AppData\\Local\\hoai\\bin'])
  // No shell profile is touched on Windows: the User PATH lives in the registry.
  assert.deepEqual(fs.appended, [])
})

test('installWrapper: a bin dir already on PATH does not ask for it again', () => {
  const fs = fakeFs(WIN_WRAPPER_FILES.map((name) => `${MARKETPLACE_ROOT_WIN}\\bin\\${name}`))
  let asked = false
  installWrapper({
    pluginRoot: MARKETPLACE_ROOT_WIN,
    platform: 'win32',
    home: WIN_HOME,
    env: {
      LOCALAPPDATA: WIN_LOCAL_APP_DATA,
      PATH: 'C:\\Windows;C:\\Users\\x\\AppData\\Local\\hoai\\bin\\',
    },
    effects: fs.effects,
    runPathHelper: () => {
      asked = true
      return true
    },
  })
  assert.equal(asked, false, 'a trailing separator and case still count as present')
})

test('installWrapper: a missing shim source is reported, never silently skipped', () => {
  const fs = fakeFs([]) // the plugin bin is not on disk
  const result = installWrapper({
    pluginRoot: CLONE_ROOT,
    platform: 'linux',
    home: POSIX_HOME,
    env: { PATH: '' },
    effects: fs.effects,
  })
  assert.equal(result.ok, false)
  assert.equal(fs.linked.length, 0)
  assert.ok(result.notes.some((note) => note.includes(`${CLONE_ROOT}/bin/hoai`)))
})

test('installWrapper: a clone whose bin IS the bin dir is left alone, not linked to itself', () => {
  // The self-loop the bootstrap's bun fix taught us: relinking a file onto
  // itself breaks the command outright.
  const root = '/home/kc/.local'
  const fs = fakeFs([`${root}/bin/hoai`])
  const result = installWrapper({
    pluginRoot: root,
    platform: 'linux',
    home: POSIX_HOME,
    env: { PATH: '/home/kc/.local/bin' },
    effects: fs.effects,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(fs.linked, [])
  assert.deepEqual(result.wrote, ['/home/kc/.local/bin/hoai'])
})

// -- PATH persistence ---------------------------------------------------------

// -- Ask or announce, never silently replace (KC, 2026-09-21) -----------------
//
// Review found two ways this call could change something the owner never asked
// it to change: pairing running it from a background daemon, and a clone
// install re-pointing the shim of a marketplace install that was already
// there. KC's ruling was to be conservative in the same direction in both
// cases. Overwriting another install's shim reports success and silently
// changes which install the owner's existing `hoai` command runs, which is the
// same class of defect as a first install failing silently.

test('installWrapper: a shim belonging to ANOTHER install is left alone and announced, never re-pointed', () => {
  const OTHER = '/home/kc/some-other-checkout/bin/hoai'
  const fs = fakeFs([`${CLONE_ROOT}/bin/hoai`])
  const result = installWrapper({
    pluginRoot: CLONE_ROOT,
    platform: 'linux',
    home: POSIX_HOME,
    env: { PATH: `${POSIX_HOME}/.local/bin` },
    effects: { ...fs.effects, readlink: () => OTHER },
  })
  assert.deepEqual(fs.linked, [], 'nothing may be linked over a foreign shim')
  assert.deepEqual(result.wrote, [], 'a declined shim is not a written one')
  assert.equal(result.kept.length, 1)
  assert.equal(result.kept[0].path, `${POSIX_HOME}/.local/bin/hoai`)
  assert.equal(result.kept[0].pointsAt, OTHER, 'the announcement names where the existing shim goes')
  assert.equal(result.kept[0].wanted, `${CLONE_ROOT}/bin/hoai`, 'and where this install would have pointed it')
  assert.equal(result.kept[0].reason, 'foreign-link')
  assert.equal(result.ok, true, 'declining is the correct outcome, not a failure')
})

test('installWrapper: a regular file the owner put there is left alone too', () => {
  // readlink answers null for "not a symlink" exactly as it does for "absent",
  // so the presence check is what tells the two apart. Getting this backwards
  // would delete a file the owner wrote.
  const fs = fakeFs([`${CLONE_ROOT}/bin/hoai`, `${POSIX_HOME}/.local/bin/hoai`])
  const result = installWrapper({
    pluginRoot: CLONE_ROOT,
    platform: 'linux',
    home: POSIX_HOME,
    env: { PATH: `${POSIX_HOME}/.local/bin` },
    effects: fs.effects,
  })
  assert.deepEqual(fs.linked, [], "the owner's own file is not replaced")
  assert.equal(result.kept.length, 1)
  assert.equal(result.kept[0].reason, 'foreign-file')
})

test('installWrapper: a shim already pointing at THIS install is rewritten, so a re-run stays idempotent', () => {
  // The rule must not cost the repair the module exists for: our own shim, and
  // a broken one pointing at our own root, are both still (re)written.
  const fs = fakeFs([`${CLONE_ROOT}/bin/hoai`])
  const result = installWrapper({
    pluginRoot: CLONE_ROOT,
    platform: 'linux',
    home: POSIX_HOME,
    env: { PATH: `${POSIX_HOME}/.local/bin` },
    effects: { ...fs.effects, readlink: () => `${CLONE_ROOT}/bin/hoai` },
  })
  assert.deepEqual(fs.linked, [{ target: `${CLONE_ROOT}/bin/hoai`, link: `${POSIX_HOME}/.local/bin/hoai` }])
  assert.deepEqual(result.kept, [], 'our own shim is not a foreign one')
})

test('installWrapper: force re-points a foreign shim, because a deliberate ask is the escape hatch', () => {
  const fs = fakeFs([`${CLONE_ROOT}/bin/hoai`])
  const result = installWrapper({
    pluginRoot: CLONE_ROOT,
    platform: 'linux',
    home: POSIX_HOME,
    env: { PATH: `${POSIX_HOME}/.local/bin` },
    effects: { ...fs.effects, readlink: () => '/home/kc/some-other-checkout/bin/hoai' },
    force: true,
  })
  assert.deepEqual(fs.linked, [{ target: `${CLONE_ROOT}/bin/hoai`, link: `${POSIX_HOME}/.local/bin/hoai` }])
  assert.deepEqual(result.kept, [], 'an explicit force is an ask, so nothing is declined')
})

test('installWrapper on win32: a breadcrumb naming ANOTHER plugin root stops the copies too', () => {
  // win32 shims are COPIES, so there is no link to inspect: the breadcrumb is
  // the only record of whose install owns this bin dir. Both shims and the
  // breadcrumb itself must be declined together, or the bin dir ends up half
  // one install and half the other.
  const fs = fakeFs([
    `${MARKETPLACE_ROOT_WIN}\\bin\\hoai.ps1`,
    `${MARKETPLACE_ROOT_WIN}\\bin\\hoai.cmd`,
  ])
  const binDir = `${WIN_LOCAL_APP_DATA}\\hoai\\bin`
  fs.files.set(`${binDir}\\hoai-plugin-root.txt`, 'C:\\Users\\x\\a-different-install\n')
  const result = installWrapper({
    pluginRoot: MARKETPLACE_ROOT_WIN,
    platform: 'win32',
    home: WIN_HOME,
    env: { LOCALAPPDATA: WIN_LOCAL_APP_DATA, Path: binDir },
    effects: fs.effects,
    runPathHelper: () => true,
  })
  assert.deepEqual(fs.copied, [], 'no shim is copied over another install')
  assert.equal(fs.written.has(`${binDir}\\hoai-plugin-root.txt`), false, 'the breadcrumb is not rewritten either')
  assert.equal(result.kept.length, 3, 'both shims and the breadcrumb are announced')
  for (const entry of result.kept) {
    assert.equal(entry.reason, 'foreign-breadcrumb')
    assert.equal(entry.pointsAt, 'C:\\Users\\x\\a-different-install')
  }
})

test('installWrapper on win32: a breadcrumb naming THIS root is our own install, so it is refreshed', () => {
  const fs = fakeFs([
    `${MARKETPLACE_ROOT_WIN}\\bin\\hoai.ps1`,
    `${MARKETPLACE_ROOT_WIN}\\bin\\hoai.cmd`,
  ])
  const binDir = `${WIN_LOCAL_APP_DATA}\\hoai\\bin`
  fs.files.set(`${binDir}\\hoai-plugin-root.txt`, `${MARKETPLACE_ROOT_WIN}\n`)
  const result = installWrapper({
    pluginRoot: MARKETPLACE_ROOT_WIN,
    platform: 'win32',
    home: WIN_HOME,
    env: { LOCALAPPDATA: WIN_LOCAL_APP_DATA, Path: binDir },
    effects: fs.effects,
    runPathHelper: () => true,
  })
  assert.equal(fs.copied.length, 2, 'our own install still refreshes its shims')
  assert.deepEqual(result.kept, [])
})

test('inspectExistingShim: the four states, told apart without a new effect', () => {
  const fx = (readlink: string | null, present: string[]) => ({
    readlink: () => readlink,
    exists: (path: string) => present.includes(path),
  })
  assert.deepEqual(inspectExistingShim('/l', '/want', fx(null, [])), {
    state: 'absent',
    pointsAt: '',
    targetExists: false,
  })
  assert.equal(inspectExistingShim('/l', '/want', fx('/want', ['/want'])).state, 'ours')
  assert.equal(inspectExistingShim('/l', '/want', fx('/want/', ['/want'])).state, 'ours', 'a trailing separator is the same path')
  assert.equal(inspectExistingShim('/l', '/want', fx('/elsewhere', ['/elsewhere'])).state, 'foreign-link')
  // A BROKEN link to somewhere else is still somewhere else: exists() follows
  // the link, so it reads as absent, and readlink is what settles it.
  const broken = inspectExistingShim('/l', '/want', fx('/gone', []))
  assert.equal(broken.state, 'foreign-link')
  assert.equal(broken.targetExists, false)
  assert.equal(inspectExistingShim('/l', '/want', fx(null, ['/l'])).state, 'foreign-file')
})

test('profileNeedsPathLine: idempotent with the bootstrap, and a missing profile is skipped', () => {
  assert.equal(profileNeedsPathLine('# fresh profile\n'), true)
  // However the user spelled it, the bootstrap's own grep would have skipped it.
  assert.equal(profileNeedsPathLine('export PATH="$HOME/.local/bin:$PATH"\n'), false)
  assert.equal(profileNeedsPathLine('PATH=$PATH:/home/kc/.local/bin\n'), false)
  // Missing file: the bootstrap does not create .bashrc either.
  assert.equal(profileNeedsPathLine(null), false)
})

test('POSIX_PROFILE_FILES: the same two profiles the bootstrap appends to', () => {
  assert.deepEqual([...POSIX_PROFILE_FILES], ['.zshrc', '.bashrc'])
})

test('installWrapper: a profile that already has the line is left untouched', () => {
  const fs = fakeFs([`${CLONE_ROOT}/bin/hoai`])
  fs.files.set(`${POSIX_HOME}/.zshrc`, `${PROFILE_PATH_LINE}\n`)
  fs.files.set(`${POSIX_HOME}/.bashrc`, '# no path line here\n')
  installWrapper({
    pluginRoot: CLONE_ROOT,
    platform: 'linux',
    home: POSIX_HOME,
    env: { PATH: '' },
    effects: fs.effects,
  })
  assert.deepEqual(
    fs.appended.map((entry) => entry.path),
    [`${POSIX_HOME}/.bashrc`],
  )
})

test('pathContainsDir: segment compare, tolerant of a trailing separator and win32 case', () => {
  assert.equal(pathContainsDir('/usr/bin:/home/kc/.local/bin', '/home/kc/.local/bin', 'linux'), true)
  assert.equal(pathContainsDir('/usr/bin:/home/kc/.local/bin/', '/home/kc/.local/bin', 'linux'), true)
  // A prefix collision is not a match.
  assert.equal(pathContainsDir('/usr/bin:/home/kc/.local/binX', '/home/kc/.local/bin', 'linux'), false)
  assert.equal(pathContainsDir('C:\\WINDOWS;c:\\users\\x\\appdata\\local\\hoai\\bin', 'C:\\Users\\x\\AppData\\Local\\hoai\\bin', 'win32'), true)
  // posix PATH is case SENSITIVE; do not fold it.
  assert.equal(pathContainsDir('/home/KC/.local/bin', '/home/kc/.local/bin', 'linux'), false)
  assert.equal(pathContainsDir('/usr/bin', '', 'linux'), false)
})

// -- The Windows PATH helper --------------------------------------------------

test('bin/hoai-add-to-path.ps1: adds a directory only, through the registry, never setx', () => {
  const ps1 = readFileSync(join(repoRoot, 'bin', 'hoai-add-to-path.ps1'), 'utf8')
  // The same mechanism as hoai-bootstrap.ps1 Ensure-OnPath.
  assert.match(ps1, /\[Environment\]::SetEnvironmentVariable\('Path', .*, 'User'\)/)
  // setx truncates PATH at 1024 chars and flattens the machine PATH into the
  // user PATH; it must never appear here.
  assert.equal(/\bsetx\b/i.test(ps1.replace(/^#.*$/gm, '')), false)
  // It is a PATH writer, not an alias writer.
  assert.equal(/Set-Alias|alias\s+hoai\s*=/.test(ps1.replace(/^#.*$/gm, '')), false)
  assert.equal(/--dangerously-load-development-channels/.test(ps1.replace(/^#.*$/gm, '')), false)
  // The test escape hatch the bootstrap uses, so a matrix run cannot mutate a
  // real user's registry PATH.
  assert.match(ps1, /HOAI_TEST_SKIP_USERPATH/)
  const emDash = String.fromCharCode(0x2014)
  const enDash = String.fromCharCode(0x2013)
  assert.equal(ps1.includes(emDash) || ps1.includes(enDash), false, 'no em or en dashes')
})
