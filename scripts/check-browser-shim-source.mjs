#!/usr/bin/env node
// Public PRs verify the recorded source hash offline. Trusted runs can also
// fetch the committed shim with --live, without executing upstream code.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function checkBrowserShimPin(pin, vendor) {
  assert.match(pin.sourceCommit, /^[0-9a-f]{40}$/, 'pin an immutable BGOS commit');
  assert.match(pin.sourceSha256, /^[0-9a-f]{64}$/, 'record the committed source hash');
  assert.equal(pin.sourceSha256, pin.sha256, 'the source and vendor pins must agree');
  assert.equal(hash(vendor), pin.sha256, 'vendored shim does not match its pin');
}

/** @param {(url: string, init: RequestInit) => Promise<Response>} [fetchSource] */
export async function checkBrowserShimSource(pin, vendor, token, fetchSource = fetch) {
  checkBrowserShimPin(pin, vendor);
  assert.ok(token, 'BGOS_SOURCE_READ_TOKEN is required to read the private BGOS source');
  const url = `https://api.github.com/repos/BrandGrowthOS/BGOS/contents/frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs?ref=${pin.sourceCommit}`;
  let response, source;
  try {
    response = await fetchSource(url, {
      headers: { Accept: 'application/vnd.github.raw+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    if (response.ok) source = Buffer.from(await response.arrayBuffer());
  } catch {
    // Never expose a token, a private response body, or a transport URL.
    throw Error('BGOS source fetch failed');
  }
  assert.ok(response.ok, `BGOS source fetch failed (${response.status})`);
  assert.equal(hash(source), pin.sourceSha256, 'committed BGOS source does not match sourceSha256');
  assert.ok(source.equals(vendor), 'committed BGOS source and vendored bytes differ');
  return source;
}

async function main() {
  const root = process.cwd();
  const pin = JSON.parse(readFileSync(join(root, 'bin/hoai-browser-mcp.vendor.json'), 'utf8'));
  const vendor = readFileSync(join(root, pin.file));
  checkBrowserShimPin(pin, vendor);
  console.log(`Verified recorded BGOS source hash ${pin.sourceCommit}: ${pin.sourceSha256}`);
  if (!process.argv.includes('--live')) {
    console.log('::notice::Live BGOS source comparison skipped: offline verification only; trusted pushes and scheduled runs use --live');
    return;
  }
  const token = process.env.BGOS_SOURCE_READ_TOKEN;
  if (!token) {
    console.log('::notice::Live BGOS source comparison skipped: BGOS_SOURCE_READ_TOKEN is unavailable; recorded source hash verified offline');
    return;
  }
  const source = await checkBrowserShimSource(pin, vendor, token);
  const cache = join(root, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'shim-source-'));
  try {
    const file = join(dir, 'hoai-browser-mcp.mjs');
    writeFileSync(file, source);
    // Run the same parity test as a checkout audit with independently fetched
    // bytes. Do not pass the source credential to the test child.
    const { BGOS_SOURCE_READ_TOKEN: _token, ...env } = process.env;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=4', 'test/hoai-browser-mcp.vendor.test.ts'], {
      cwd: root, env: { ...env, HOAI_BROWSER_SHIM_SOURCE: file }, stdio: 'inherit', windowsHide: true,
    });
    assert.equal(result.status, 0, 'pinned BGOS parity tests failed');
    console.log(`Verified BGOS source ${pin.sourceCommit}: ${pin.sourceSha256}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
