import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import * as sourceCheck from '../scripts/check-browser-shim-source.mjs'

const { applyShimPatch, checkBrowserShimPin, checkBrowserShimSource } = sourceCheck

const bytes = Buffer.from('synthetic committed shim\n')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const pin = { sourceCommit: 'a'.repeat(40), sourceSha256: sha256, sha256 }

test('CI fetches the immutable BGOS commit and checks independently returned bytes', async () => {
  let called = false
  await checkBrowserShimSource(pin, bytes, 'synthetic-read-token', async (url: string, init: RequestInit) => {
    called = true
    assert.equal(url, `https://api.github.com/repos/BrandGrowthOS/BGOS/contents/frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs?ref=${pin.sourceCommit}`)
    assert.equal(init.redirect, 'error')
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-read-token')
    return new Response(bytes)
  })
  assert.ok(called, 'local pin agreement must never replace the upstream lookup')
})

test('a wrong source commit fails even when both local hashes still agree', async () => {
  await assert.rejects(checkBrowserShimSource({ ...pin, sourceCommit: '0'.repeat(40) }, bytes, 'synthetic-read-token', async (url: string) => {
    assert.ok(url.endsWith(`?ref=${'0'.repeat(40)}`))
    return new Response('synthetic private upstream error', { status: 404 })
  }), /BGOS source fetch failed \(404\)/)
})

test('changing the shim and both hashes cannot pass against stale committed source', async () => {
  const changed = Buffer.from('changed vendor\n')
  const hash = createHash('sha256').update(changed).digest('hex')
  await assert.rejects(checkBrowserShimSource({ ...pin, sha256: hash, sourceSha256: hash }, changed, 'synthetic-read-token', async () => new Response(bytes)), /committed BGOS source does not match sourceSha256/)
})

test('CI fails closed without credentials and never reports upstream secrets', async () => {
  await assert.rejects(checkBrowserShimSource(pin, bytes, '', async () => assert.fail('must not fetch without credentials')), /BGOS_SOURCE_READ_TOKEN is required/)
  await assert.rejects(checkBrowserShimSource(pin, bytes, 'synthetic-read-token', async () => { throw Error('synthetic-read-token private upstream error') }), error => {
    assert.equal((error as Error).message, 'BGOS source fetch failed')
    return true
  })
})

test('malformed commits, inconsistent pins and vendor drift fail', async () => {
  const fetchSource = async () => new Response(bytes)
  await assert.rejects(checkBrowserShimSource({ ...pin, sourceCommit: '../main' }, bytes, 'token', fetchSource), /immutable BGOS commit/)
  await assert.rejects(checkBrowserShimSource({ ...pin, sha256: '0'.repeat(64) }, bytes, 'token', fetchSource), /source and vendor pins must agree/)
  await assert.rejects(checkBrowserShimSource(pin, Buffer.from('drift'), 'token', fetchSource), /vendored shim does not match/)
})

test('the offline check validates the committed source hash without a token or fetch', () => {
  assert.equal(typeof sourceCheck.checkBrowserShimPin, 'function', 'export the offline pin verifier')
  sourceCheck.checkBrowserShimPin(pin, bytes)
  assert.throws(() => sourceCheck.checkBrowserShimPin({ ...pin, sourceCommit: '../main' }, bytes), /immutable BGOS commit/)
  assert.throws(() => sourceCheck.checkBrowserShimPin({ ...pin, sourceSha256: 'not-a-hash' }, bytes), /committed source hash/)
  assert.throws(() => sourceCheck.checkBrowserShimPin({ ...pin, sha256: '0'.repeat(64) }, bytes), /source and vendor pins must agree/)
  assert.throws(() => sourceCheck.checkBrowserShimPin(pin, Buffer.from('drift')), /vendored shim does not match/)
})

function runVerifier(args: string[], token: string, preload: string) {
  return spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    'scripts/check-browser-shim-source.mjs', ...args,
  ], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, BGOS_SOURCE_READ_TOKEN: token, HOAI_BROWSER_SHIM_SOURCE: '', NODE_TEST_CONTEXT: undefined },
  })
}

const noNetwork = `globalThis.fetch = () => { throw Error('network forbidden in offline verification') }`

test('fork CLI checks the recorded hash offline and clearly skips live verification', () => {
  const result = runVerifier([], '', noNetwork)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Verified recorded BGOS source hash/)
  assert.match(result.stdout, /::notice::Live BGOS source comparison skipped/)
  // Even a populated local environment must not make the default command fetch.
  const withToken = runVerifier([], 'synthetic-read-token', noNetwork)
  assert.equal(withToken.status, 0, withToken.stderr)
  assert.match(withToken.stdout, /comparison skipped/)
})

test('a trusted run without the secret keeps the offline check and reports a skip', () => {
  const result = runVerifier(['--live'], '', noNetwork)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Verified recorded BGOS source hash/)
  assert.match(result.stdout, /::notice::Live BGOS source comparison skipped: BGOS_SOURCE_READ_TOKEN is unavailable/)
})

// Answers with the BGOS bytes the pin records: the vendored copy at parity, or
// the copy minus the committed ahead patch when this copy leads. Built here, as
// importing the verifier inside its own preload would start its CLI early.
function recordedSource(dir: string) {
  const vendorPin = JSON.parse(readFileSync('bin/hoai-browser-mcp.vendor.json', 'utf8'))
  const vendor = readFileSync(vendorPin.file)
  const file = join(dir, 'recorded-source.mjs')
  writeFileSync(file, vendorPin.aheadOfSource ? applyShimPatch(readFileSync(vendorPin.aheadOfSource.patch), vendor, { reverse: true }) : vendor)
  return `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    const pin = JSON.parse(readFileSync('bin/hoai-browser-mcp.vendor.json', 'utf8'));
    const source = readFileSync(${JSON.stringify(file)});
    globalThis.fetch = async (url, init) => {
      assert.ok(url.endsWith('?ref=' + pin.sourceCommit));
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-read-token');
      return new Response(source);
    };
  `
}

test('trusted CLI fetches source and runs the supplied-source vendor suite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shim-live-'))
  let result
  try {
    result = runVerifier(['--live'], 'synthetic-read-token', recordedSource(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Verified BGOS source/)
  assert.match(result.stdout, /pass 8/)
  assert.match(result.stdout, /fail 0/)
  assert.match(result.stdout, /skipped 0/)
  assert.doesNotMatch(result.stdout, /comparison skipped/)
})

test('plugin CI separates unconditional offline tests from trusted live verification', () => {
  const workflow = readFileSync('.github/workflows/tests.yml', 'utf8')
  const linux = workflow.match(/^  test:\n[\s\S]*?(?=^  [a-z]|$(?![\s\S]))/m)?.[0]
  assert.ok(linux)
  const offline = linux.match(/      - name: Verify pinned BGOS browser shim\n(?:(?!      - ).*\n)*/)?.[0]
  assert.ok(offline, 'Linux tests always check the recorded source hash')
  assert.match(offline, /run: node scripts\/check-browser-shim-source\.mjs\n/)
  assert.doesNotMatch(offline, /\bif:|secrets\.|--live|continue-on-error/)
  assert.doesNotMatch(linux, /BGOS_SOURCE_READ_TOKEN|needs:/)
  assert.match(linux, /- name: Run tests\n        run: npm test/)

  const live = workflow.match(/^  verify-browser-shim-source:\n[\s\S]*?(?=^  [a-z]|$(?![\s\S]))/m)?.[0]
  assert.ok(live, 'keep a separate live provenance job')
  assert.match(live, /if: github\.event_name == 'push' \|\| github\.event_name == 'schedule'/)
  assert.match(live, /run: node scripts\/check-browser-shim-source\.mjs --live/)
  assert.match(live, /BGOS_SOURCE_READ_TOKEN: \$\{\{ secrets\.BGOS_SOURCE_READ_TOKEN \}\}/)
  assert.doesNotMatch(live, /continue-on-error/)
  assert.match(workflow, /  schedule:\n    - cron:/)
  assert.doesNotMatch(workflow, /pull_request_target/)
})

// A synthetic copy that leads its source by one reviewed hunk.
const base = Buffer.from('one\ntwo\nthree\nfour\n')
const ahead = Buffer.from('one\ntwo\nguard\nthree\nfour\n')
const patch = Buffer.from('--- a/shim.mjs\n+++ b/shim.mjs\n@@ -1,4 +1,5 @@\n one\n two\n+guard\n three\n four\n')
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const aheadPin = {
  sourceCommit: 'b'.repeat(40), sourceSha256: digest(base), sha256: digest(ahead),
  aheadOfSource: { patch: 'bin/hoai-browser-mcp.ahead.patch', bgosFollowUp: 'land the synthetic patch' },
}

test('an ahead pin is its BGOS source plus exactly the committed patch', () => {
  assert.ok(applyShimPatch(patch, base).equals(ahead))
  assert.ok(checkBrowserShimPin(aheadPin, ahead, patch).equals(base), 'the offline check rebuilds the recorded source')
  // Anything extra in the copy, a patch that does not match, or a wrong base hash fails.
  const extra = Buffer.from('one\ntwo\nguard\nthree\nfour\nmore\n')
  assert.throws(() => checkBrowserShimPin({ ...aheadPin, sha256: digest(extra) }, extra, patch), /not the recorded BGOS source/)
  assert.throws(() => checkBrowserShimPin(aheadPin, ahead, Buffer.from(patch.toString().replace('+guard', '+other'))), /does not apply/)
  assert.throws(() => checkBrowserShimPin({ ...aheadPin, sourceSha256: '0'.repeat(64) }, ahead, patch), /not the recorded BGOS source/)
  assert.throws(() => checkBrowserShimPin(aheadPin, ahead, Buffer.from(patch.toString().replace('-1,4 +1,5', '-1,3 +1,5'))), /hunk counts/)
  assert.throws(() => checkBrowserShimPin(aheadPin, ahead, Buffer.from(patch.toString().replace(/\n/g, '\r\n'))), /LF/)
})

test('an ahead pin must name its patch and follow-up, and cannot claim parity', () => {
  assert.throws(() => checkBrowserShimPin(aheadPin, ahead), /needs bin\/hoai-browser-mcp.ahead.patch/)
  assert.throws(() => checkBrowserShimPin({ ...aheadPin, aheadOfSource: 'BGOS must copy this' }, ahead, patch), /must name its patch/)
  assert.throws(() => checkBrowserShimPin({ ...aheadPin, aheadOfSource: { ...aheadPin.aheadOfSource, patch: 'other.patch' } }, ahead, patch), /records its delta/)
  assert.throws(() => checkBrowserShimPin({ ...aheadPin, aheadOfSource: { patch: aheadPin.aheadOfSource.patch } }, ahead, patch), /what BGOS must land/)
  assert.throws(() => checkBrowserShimPin({ ...aheadPin, sourceSha256: digest(ahead) }, ahead, patch), /at parity remove aheadOfSource/)
})

test('live verification of an ahead pin fetches the base and rebuilds the copy from it', async () => {
  const fetched = await checkBrowserShimSource(aheadPin, ahead, 'synthetic-read-token', async () => new Response(base), patch)
  assert.ok(fetched.equals(base))
  // BGOS answering with the copy itself, or anything else, is not the recorded base.
  await assert.rejects(checkBrowserShimSource(aheadPin, ahead, 'synthetic-read-token', async () => new Response(ahead), patch), /committed BGOS source does not match sourceSha256/)
})

test('the armed cross-tree case fails on the bare base until BGOS holds the new bytes', () => {
  const vendorPin = JSON.parse(readFileSync('bin/hoai-browser-mcp.vendor.json', 'utf8'))
  if (vendorPin.aheadOfSource === undefined) return
  const dir = mkdtempSync(join(tmpdir(), 'shim-ahead-'))
  try {
    const vendor = readFileSync(vendorPin.file)
    const baseFile = join(dir, 'base.mjs'), landedFile = join(dir, 'landed.mjs')
    writeFileSync(baseFile, applyShimPatch(readFileSync(vendorPin.aheadOfSource.patch), vendor, { reverse: true }))
    writeFileSync(landedFile, vendor)
    const run = (source: string) => spawnSync(process.execPath, ['--import', 'tsx', '--test', 'test/hoai-browser-mcp.vendor.test.ts'], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOAI_BROWSER_SHIM_SOURCE: source, NODE_TEST_CONTEXT: undefined },
    })
    const behind = run(baseFile)
    assert.equal(behind.status, 1, behind.stdout)
    assert.match(behind.stdout, /still the pinned base; this copy is ahead by bin\/hoai-browser-mcp\.ahead\.patch/)
    const landed = run(landedFile)
    assert.equal(landed.status, 0, landed.stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
