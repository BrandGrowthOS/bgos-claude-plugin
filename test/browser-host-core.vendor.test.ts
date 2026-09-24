/**
 * The vendored permission rules are pinned by hash, not by a sentence.
 *
 * WHY THIS FILE EXISTS. `lib/browser-host-core/policy.js` and
 * `settings.js` are byte-identical COPIES of the BGOS agent-browser rule tier
 * (`frontend/electron-app/agent-browser/`). They are copied rather than
 * re-implemented for one reason: a daemon-placed agent must be judged by
 * EXACTLY the rules the desktop Agent Browser uses. Two hand-written copies of
 * a permission policy is how two hosts quietly come to disagree about what
 * counts as a credential, or a sensitive action, or a blocked category, and
 * the disagreement surfaces as an agent doing something on one machine that it
 * would have been stopped from doing on another.
 *
 * The shim next door learned the cost of an unchecked copy: its sha256 lived
 * in a commit message for one round, the BGOS original was fixed twice, and
 * this repo shipped the stale copy with a dead relay lane until a human caught
 * it. See `test/hoai-browser-mcp.vendor.test.ts`. So these hashes live in
 * `lib/browser-host-core/vendor.json` and this test reads them.
 *
 * What each case buys:
 *
 *  - the pin vs the file on disk: a re-vendor cannot land silently. It either
 *    matches the pin or it fails here, which forces whoever re-vendors to
 *    state the new hash in the tree, and so to have looked at the diff.
 *  - LF, and the `.gitattributes` entries that guarantee it: without them
 *    `core.autocrlf` hands a Windows checkout a different byte sequence and
 *    the hash is unverifiable on disk for exactly the people most likely to
 *    check it.
 *  - the require shape: `settings.js` does `require("./policy")`, which is the
 *    reason these keep their ORIGINAL filenames in a directory of their own
 *    rather than being flattened into `lib/` with new names. A rename would
 *    break that require, and a patched require would break byte-identity,
 *    which is the property the hash exists to protect.
 *  - the type declaration: the plugin root is `type: module` and these two
 *    files are CommonJS, so the nested `package.json` is load-bearing. Without
 *    it Node reads them as ESM and the host cannot import the rules at all.
 *  - the cross-tree case: the BGOS tree is a separate private repo and is NOT
 *    on this repo's CI runner, so this suite cannot compare the two on its
 *    own. It is skipped with a reason unless HOAI_BROWSER_HOST_CORE_SOURCE
 *    points at the BGOS agent-browser directory.
 *
 * WHAT THIS DOES NOT BUY, stated because the shim's equivalent says the same
 * and it is the half that actually bit: nothing here fires when the BGOS
 * originals change and these copies do not. That check can only live on the
 * BGOS side, and for this tier it does:
 * `frontend/electron-app/agent-browser/__tests__/hostCoreVendorPin.test.js`
 * pins these same two hashes there, so editing policy.js in BGOS fails BGOS's
 * own suite until someone re-vendors here. That is the half the shim never got.
 *
 * Run: npm test, or npx tsx --test test/browser-host-core.vendor.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CORE = join(ROOT, 'lib', 'browser-host-core')
/**
 * DERIVED FROM DISK, never hand-listed.
 *
 * This was `['policy.js', 'settings.js']`, a literal, and it silently did
 * nothing when `profiles.js` was vendored beside them: the file was copied,
 * pinned in vendor.json, and every case here stayed green because none of
 * them looked at it. A mutation proved it, which is the only reason it was
 * caught. A hand-written list of the things to check is a list that stops
 * matching what is there, and it fails in the reassuring direction.
 *
 * So the set comes from the directory, and the case below asserts vendor.json
 * declares EXACTLY it. A new copy with no pin is then a failure, and a pin
 * whose file is gone is a failure too.
 */
const VENDORED = readdirSync(CORE)
  .filter((name) => name.endsWith('.js'))
  .sort()

type Pin = {
  files: Record<string, { source: string; sha256: string }>
}

function pin(): Pin {
  return JSON.parse(readFileSync(join(CORE, 'vendor.json'), 'utf8')) as Pin
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

test('every vendored file matches the sha256 the tree declares for it', () => {
  const declared = pin().files
  for (const name of VENDORED) {
    const entry = declared[name]
    assert.ok(entry, `vendor.json declares no pin for ${name}`)
    assert.equal(
      sha256Of(join(CORE, name)),
      entry.sha256,
      `${name} does not match its pin. Either it was edited here, which it must never be, or it was re-vendored without updating lib/browser-host-core/vendor.json.`,
    )
  }
})

test('vendor.json pins EXACTLY the files that are here, so a copy cannot arrive unpinned', () => {
  // The case that would have caught profiles.js arriving with nobody
  // checking it. Both directions matter: an unpinned copy is an unchecked
  // copy, and a pin with no file is a pin nothing can ever fail.
  const declared = Object.keys(pin().files).sort()
  assert.deepEqual(declared, [...VENDORED], 'every .js in lib/browser-host-core must be pinned in vendor.json, and nothing else')
  assert.ok(VENDORED.length >= 2, 'the directory should hold the vendored rules; an empty read would pass the line above vacuously')
})

test('the pin names a BGOS source path for each file, so the original is findable', () => {
  const declared = pin().files
  for (const name of VENDORED) {
    assert.match(
      declared[name]!.source,
      /^BGOS: frontend\/electron-app\/agent-browser\//,
      `${name} must say which BGOS file it copies`,
    )
    assert.ok(declared[name]!.source.endsWith(name), `${name}'s source path must end in its own filename`)
  }
})

test('the vendored files are LF only, and .gitattributes says so', () => {
  const attrs = readFileSync(join(ROOT, '.gitattributes'), 'utf8')
  for (const name of VENDORED) {
    const bytes = readFileSync(join(CORE, name))
    assert.equal(bytes.includes(0x0d), false, `${name} contains a CR; the pin is then unverifiable on a Windows checkout`)
    assert.match(
      attrs,
      new RegExp(`^lib/browser-host-core/${name.replace('.', '\\.')} text eol=lf$`, 'm'),
      `.gitattributes must pin ${name} to LF, or core.autocrlf makes its hash unreadable`,
    )
  }
})

test('the copies keep their original filenames, because settings.js requires ./policy by name', () => {
  const settings = readFileSync(join(CORE, 'settings.js'), 'utf8')
  assert.match(
    settings,
    /require\("\.\/policy"\)/,
    'settings.js requires ./policy; that is why these files are not renamed when vendored',
  )
  assert.ok(existsSync(join(CORE, 'policy.js')), 'policy.js must sit beside settings.js for that require to resolve')
})

test('the nested package.json declares commonjs, without which the host cannot load the rules at all', () => {
  const pkg = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8')) as { type?: string }
  assert.equal(pkg.type, 'commonjs', 'the plugin root is type=module; these two files are CommonJS')
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { type?: string }
  assert.equal(rootPkg.type, 'module', 'if the root ever stops being ESM this nested declaration needs rethinking')
})

test('the rules actually load and decide, so a passing hash is not the only thing proven', () => {
  const require_ = createRequire(import.meta.url)
  const policy = require_(join(CORE, 'policy.js')) as {
    classifyToolCall: (n: string, a?: object, c?: object) => { kind: string }
    decide: (i: object) => { verdict: string; gate?: string; reason?: string }
  }
  const call = (name: string, args: object, origin: string | null) =>
    policy.decide({
      profile: 'preview',
      classification: policy.classifyToolCall(name, args, { currentOrigin: origin }),
      grants: {},
      settings: {},
      preapproved: [],
    })

  // A read never asks. The positive control for everything below: if this one
  // asked too, the rules would be refusing indiscriminately rather than judging.
  assert.equal(call('browser_snapshot', {}, 'https://example.com').verdict, 'allow')
  // A new origin asks, which is the whole point of moving the gates here.
  assert.deepEqual(
    (({ verdict, gate }) => ({ verdict, gate }))(call('browser_navigate', { url: 'https://example.com' }, null)),
    { verdict: 'ask', gate: 'navigate' },
  )
  // A hard deny stays a deny, and is not merely an ask the owner could wave through.
  assert.equal(call('browser_navigate', { url: 'http://192.168.1.5/' }, null).verdict, 'deny')
  // A tool HOAI never exposes is refused rather than gated.
  assert.equal(call('browser_run_code_unsafe', {}, 'https://example.com').verdict, 'deny')
})

const bgosSource = process.env.HOAI_BROWSER_HOST_CORE_SOURCE
test('cross tree: each copy is byte-identical to the BGOS original', { skip: bgosSource ? false : 'set HOAI_BROWSER_HOST_CORE_SOURCE to the BGOS agent-browser directory' }, () => {
  for (const name of VENDORED) {
    const original = join(bgosSource!, name)
    assert.ok(existsSync(original), `${original} does not exist; point HOAI_BROWSER_HOST_CORE_SOURCE at the BGOS agent-browser directory`)
    assert.equal(sha256Of(join(CORE, name)), sha256Of(original), `${name} has drifted from the BGOS original`)
  }
})
