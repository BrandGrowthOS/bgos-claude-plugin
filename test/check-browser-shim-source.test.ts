import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { checkBrowserShimSource } from '../scripts/check-browser-shim-source.mjs'

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

test('plugin CI runs the upstream check without a conditional skip', () => {
  const workflow = readFileSync('.github/workflows/tests.yml', 'utf8')
  const step = workflow.match(/      - name: Verify pinned BGOS browser shim\n(?:(?!      - ).*\n)*/)?.[0]
  assert.ok(step, 'the plugin test job must verify the upstream source')
  assert.match(step, /run: node scripts\/check-browser-shim-source\.mjs/)
  assert.match(step, /BGOS_SOURCE_READ_TOKEN: \$\{\{ secrets\.BGOS_SOURCE_READ_TOKEN \}\}/)
  assert.doesNotMatch(step, /\bif:|continue-on-error/)
})
