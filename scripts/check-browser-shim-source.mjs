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
/** The committed delta of a plugin copy that leads its BGOS source. */
export const AHEAD_PATCH = 'bin/hoai-browser-mcp.ahead.patch';

/**
 * Apply a strict single-file unified diff to LF text. Every context and removed
 * line must match exactly, so a patch that does not describe these bytes fails.
 * reverse: true turns the vendored copy back into the BGOS source it started from.
 */
export function applyShimPatch(patch, bytes, { reverse = false } = {}) {
  const text = bytes.toString('utf8');
  assert.ok(Buffer.from(text, 'utf8').equals(bytes) && text.endsWith('\n') && !text.includes('\r'), 'the shim must be LF UTF-8 text ending in a newline');
  const body = patch.toString('utf8');
  assert.ok(!body.includes('\r') && body.endsWith('\n'), 'the ahead patch must be LF text');
  const lines = text.slice(0, -1).split('\n'), rows = body.slice(0, -1).split('\n');
  assert.ok(rows[0]?.startsWith('--- ') && rows[1]?.startsWith('+++ '), 'the ahead patch must be a unified diff of one file');
  const [del, add] = reverse ? ['+', '-'] : ['-', '+'];
  const out = [];
  let pos = 0, i = 2, hunks = 0;
  while (i < rows.length) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rows[i++]);
    assert.ok(head, 'malformed ahead patch hunk');
    hunks++;
    const [oldStart, oldCount, newStart, newCount] = [head[1], head[2] ?? '1', head[3], head[4] ?? '1'].map(Number);
    const [from, count] = reverse ? [newStart, newCount] : [oldStart, oldCount];
    const start = count === 0 ? from : from - 1;
    assert.ok(start >= pos && start <= lines.length, 'ahead patch hunks out of order');
    out.push(...lines.slice(pos, start));
    pos = start;
    let seenOld = 0, seenNew = 0;
    while (i < rows.length && !rows[i].startsWith('@@')) {
      const row = rows[i++], tag = row[0], line = row.slice(1);
      assert.ok(tag === ' ' || tag === '-' || tag === '+', 'malformed ahead patch line');
      if (tag !== add) {
        assert.equal(lines[pos], line, 'the ahead patch does not apply to these bytes');
        pos++;
      }
      if (tag !== del) out.push(line);
      if (tag !== '+') seenOld++;
      if (tag !== '-') seenNew++;
    }
    assert.ok(seenOld === oldCount && seenNew === newCount, 'ahead patch hunk counts are wrong');
  }
  assert.ok(hunks > 0, 'the ahead patch is empty');
  out.push(...lines.slice(pos));
  return Buffer.from(out.join('\n') + '\n', 'utf8');
}

/**
 * A parity pin: the vendored bytes are the BGOS blob. An ahead pin: the vendored
 * bytes are that blob plus the committed aheadOfSource.patch, and nothing else.
 * Returns the BGOS source bytes the pin claims, rebuilt offline.
 * @param {Buffer} vendor
 * @param {Buffer} [patch]
 * @returns {Buffer}
 */
export function checkBrowserShimPin(pin, vendor, patch) {
  assert.match(pin.sourceCommit, /^[0-9a-f]{40}$/, 'pin an immutable BGOS commit');
  assert.match(pin.sourceSha256, /^[0-9a-f]{64}$/, 'record the committed source hash');
  if (pin.aheadOfSource === undefined) {
    assert.equal(pin.sourceSha256, pin.sha256, 'the source and vendor pins must agree');
    assert.equal(hash(vendor), pin.sha256, 'vendored shim does not match its pin');
    return vendor;
  }
  assert.match(pin.sha256, /^[0-9a-f]{64}$/, 'record the vendored hash');
  assert.equal(hash(vendor), pin.sha256, 'vendored shim does not match its pin');
  const ahead = pin.aheadOfSource;
  assert.ok(ahead && typeof ahead === 'object', 'aheadOfSource must name its patch');
  assert.equal(ahead.patch, AHEAD_PATCH, `an ahead pin records its delta in ${AHEAD_PATCH}`);
  assert.match(ahead.bgosFollowUp ?? '', /\S/, 'an ahead pin says what BGOS must land');
  assert.notEqual(pin.sourceSha256, pin.sha256, 'an ahead pin must differ from its source; at parity remove aheadOfSource');
  assert.ok(Buffer.isBuffer(patch), `an ahead pin needs ${AHEAD_PATCH}`);
  const source = applyShimPatch(patch, vendor, { reverse: true });
  assert.equal(hash(source), pin.sourceSha256, 'the vendored shim minus the ahead patch is not the recorded BGOS source');
  assert.ok(applyShimPatch(patch, source).equals(vendor), 'the ahead patch does not rebuild the vendored shim');
  return source;
}

/**
 * @param {(url: string, init: RequestInit) => Promise<Response>} [fetchSource]
 * @param {Buffer} [patch] the committed ahead patch, required for an ahead pin
 * @returns {Promise<Buffer>} the fetched BGOS source
 */
export async function checkBrowserShimSource(pin, vendor, token, fetchSource = fetch, patch) {
  checkBrowserShimPin(pin, vendor, patch);
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
  if (pin.aheadOfSource === undefined) assert.ok(source.equals(vendor), 'committed BGOS source and vendored bytes differ');
  else assert.ok(applyShimPatch(patch, source).equals(vendor), 'committed BGOS source plus the ahead patch is not the vendored shim');
  return source;
}

async function main() {
  const root = process.cwd();
  const pin = JSON.parse(readFileSync(join(root, 'bin/hoai-browser-mcp.vendor.json'), 'utf8'));
  const vendor = readFileSync(join(root, pin.file));
  const patch = pin.aheadOfSource === undefined ? undefined : readFileSync(join(root, AHEAD_PATCH));
  checkBrowserShimPin(pin, vendor, patch);
  console.log(`Verified recorded BGOS source hash ${pin.sourceCommit}: ${pin.sourceSha256}`);
  if (patch) console.log(`::notice::The vendored shim is ahead of BGOS by ${AHEAD_PATCH}; BGOS must land it: ${pin.aheadOfSource.bgosFollowUp}`);
  if (!process.argv.includes('--live')) {
    console.log('::notice::Live BGOS source comparison skipped: offline verification only; trusted pushes and scheduled runs use --live');
    return;
  }
  const token = process.env.BGOS_SOURCE_READ_TOKEN;
  if (!token) {
    console.log('::notice::Live BGOS source comparison skipped: BGOS_SOURCE_READ_TOKEN is unavailable; recorded source hash verified offline');
    return;
  }
  const source = await checkBrowserShimSource(pin, vendor, token, fetch, patch);
  const cache = join(root, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'shim-source-'));
  try {
    const file = join(dir, 'hoai-browser-mcp.mjs');
    // An ahead copy is checked against the fetched source plus the committed
    // patch; the bare BGOS blob fails the cross-tree case until BGOS lands it.
    writeFileSync(file, patch ? applyShimPatch(patch, source) : source);
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
