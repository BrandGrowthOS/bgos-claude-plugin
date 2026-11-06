import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import * as sourceCheck from '../scripts/check-browser-shim-source.mjs'

const { checkBrowserShimSource } = sourceCheck

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

test('trusted CLI fetches source and runs the supplied-source vendor suite', () => {
  const result = runVerifier(['--live'], 'synthetic-read-token', `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    const pin = JSON.parse(readFileSync('bin/hoai-browser-mcp.vendor.json', 'utf8'));
    globalThis.fetch = async (url, init) => {
      assert.ok(url.endsWith('?ref=' + pin.sourceCommit));
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-read-token');
      return new Response(readFileSync(pin.file));
    };
  `)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Verified BGOS source/)
  assert.match(result.stdout, /pass 6/)
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
