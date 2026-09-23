/**
 * hoai-browser-host tests: the agent's own browser, on the machine it lives on.
 *
 * What is worth pinning, in order of what it costs when it breaks:
 *
 *   1. PROFILE ISOLATION. The profile directory is keyed by the frame's
 *      principal, not by the agent. Two principals that resolved to one
 *      directory would hand one person's logins to another, so the first
 *      tests fail the moment any two distinct principal values share a
 *      directory, including on a case-insensitive disk, and the last test
 *      proves it with a real Chromium: a cookie set for one principal is not
 *      sent for another, and survives a browser restart for its own.
 *   2. The wire the backend already speaks: the handshake (token in the
 *      query; role, agents and label in the auth; only THIS pairing's
 *      agents), the browser_rpc frame, the result POST (same pairing token,
 *      the socket the frame arrived on, no post for a notification).
 *   3. The tool roster the desktop serves, and a clear answer when no
 *      Chrome or Chromium is installed.
 *
 * The fake relay (helpers/fake-browser-relay.ts) is built from the backend's
 * shipped gateway, relay and result route. Run: npm test, or bun test.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'

import {
  BROWSER_HOST_ROLE,
  BrowserHost,
  BrowserHostCore,
  BrowserPool,
  DEFAULT_CAPS,
  HostError,
  NEVER_TOOLS,
  OWNER_PRINCIPAL,
  PairingConnection,
  RelaySessions,
  SESSION_TOOLS,
  browserNotFoundMessage,
  browserPathsFor,
  chromeArgs,
  chromeCandidates,
  chromeEnv,
  launchChromium,
  scopeFromEnv,
  scopePairings,
  handshakeOptions,
  hostInstructions,
  isSnapChromium,
  listTools,
  principalDirName,
  readDevToolsActivePort,
  readFramePrincipal,
  readPairings,
  resolveChromeExecutable,
  resultBody,
  resultUrl,
  servedBrowserTools,
} from '../bin/hoai-browser-host.mjs'
import { startFakeRelay } from './helpers/fake-browser-relay.ts'

const HOST_BIN = join(process.cwd(), 'bin', 'hoai-browser-host.mjs')
const ROOT = join(sep, 'home', 'kc', '.bgos-agent')

/** The profile directory a frame lands in, exactly as the host derives it. */
function profileDirForFrame(frame: Record<string, unknown>, assistantId = 900): string {
  const principal = readFramePrincipal(frame)
  assert.ok(principal.ok, `the frame's principal is readable: ${JSON.stringify(frame)}`)
  return browserPathsFor({ agentRoot: ROOT, assistantId, principal: principal.principal }).profileDir
}

// ── 1. Profile isolation ─────────────────────────────────────────────────────

// Pairs of principal values that are DIFFERENT and must stay different. Each
// is a way a sanitizer or a disk has collapsed two names somewhere before:
// case only (APFS and NTFS fold it), whitespace, a replaced character, a
// separator, a dot, a traversal, a truncation boundary, unicode, and the
// owner fallback against a real person.
const DISTINCT_PRINCIPALS: Array<[string, string]> = [
  ['user-user_2NNEqL2nrIRdJ194ndJqAHwEfxC', 'user-user_2NNEqL2nrIRdJ194ndJqAHwEfxD'],
  ['user-user_2abcDEF', 'user-user_2ABCdef'],
  ['user-alice', 'user-bob'],
  ['owner', 'user-user_2NNEqL2nrIRdJ194ndJqAHwEfxC'],
  ['user-x', ' user-x'],
  ['user-x', 'user-x '],
  ['user-a/b', 'user-a_b'],
  ['user-a.b', 'user-a_b'],
  ['user-a b', 'user-a_b'],
  ['../owner', 'owner'],
  ['..', '.'],
  ['user-' + 'a'.repeat(80), 'user-' + 'a'.repeat(81)],
  ['user-' + 'a'.repeat(59), 'user-' + 'a'.repeat(59) + 'b'],
  ['user-müller', 'user-muller'],
  ['USER-X', 'user-x'],
  ['con', 'p_con'],
  ['group-7', 'user-7'],
]

test('PROFILE ISOLATION: two different principal values never resolve to one profile directory', () => {
  for (const [a, b] of DISTINCT_PRINCIPALS) {
    const dirA = profileDirForFrame({ principal: a })
    const dirB = profileDirForFrame({ principal: b })
    assert.notEqual(dirA, dirB, `principals ${JSON.stringify(a)} and ${JSON.stringify(b)} must not share ${dirA}`)
    // A case-insensitive disk (macOS, Windows) would still merge them.
    assert.notEqual(dirA.toLowerCase(), dirB.toLowerCase(), `principals ${JSON.stringify(a)} and ${JSON.stringify(b)} collide on a case-insensitive disk`)
  }
  // And not just pairwise: the whole set is distinct.
  const all = [...new Set(DISTINCT_PRINCIPALS.flat())]
  const dirs = new Set(all.map((p) => profileDirForFrame({ principal: p }).toLowerCase()))
  assert.equal(dirs.size, all.length, 'every distinct principal gets its own directory')
})

test('PROFILE ISOLATION: the frame path launches one browser per principal, and the same principal reuses its own', async () => {
  const { pool, launched } = fakePool()
  const relay = relayOver(pool)
  const nav = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://example.com' } } })
  const alice = await relay.relay({ clientId: 'c1', assistantId: 900, principal: 'user-user_2Alice', message: nav(1) })
  const bob = await relay.relay({ clientId: 'c1', assistantId: 900, principal: 'user-user_2Bob', message: nav(2) })
  const owner = await relay.relay({ clientId: 'c1', assistantId: 900, message: nav(3) })
  const aliceAgain = await relay.relay({ clientId: 'c1', assistantId: 900, principal: 'user-user_2Alice', message: nav(4) })
  for (const answer of [alice, bob, owner, aliceAgain]) assert.equal(answer.ok, true, JSON.stringify(answer))
  assert.equal(launched.length, 3, `three principals, three browsers: ${launched.join(', ')}`)
  assert.equal(new Set(launched).size, 3, 'each principal got its own profile directory')
  assert.equal(launched[2], join(ROOT, '900', 'browser', OWNER_PRINCIPAL), 'a frame with no principal is the owner')
  assert.match(textOf(alice), new RegExp(escapeRe(launched[0])))
  assert.match(textOf(aliceAgain), new RegExp(escapeRe(launched[0])), "Alice's second call ran in Alice's browser")
  assert.match(textOf(bob), new RegExp(escapeRe(launched[1])), "Bob's call ran in Bob's browser")
  relay.close()
})

test('the profile directory: ~/.bgos-agent/<assistantId>/browser/<principal>, owner when absent', () => {
  assert.equal(profileDirForFrame({}), join(ROOT, '900', 'browser', 'owner'))
  assert.equal(profileDirForFrame({ principal: undefined }), join(ROOT, '900', 'browser', 'owner'))
  // An explicit "owner" IS the fallback value, so it is the same directory.
  assert.equal(profileDirForFrame({ principal: 'owner' }), join(ROOT, '900', 'browser', 'owner'))
  assert.equal(profileDirForFrame({ principal: 'user-42' }), join(ROOT, '900', 'browser', 'user-42'))
  // Today's value is user-<clerkUserId>; Clerk ids carry upper case, so the
  // name is lower cased for reading and made unique by the digest.
  assert.match(basename(profileDirForFrame({ principal: 'user-user_2NNEqL2nrIRdJ194ndJqAHwEfxC' })), /^user-user_2nneql2nrirdj1\.[0-9a-f]{32}$/)
  // The same principal is the same directory every time, and another agent's
  // browser for the same person is another directory.
  assert.equal(profileDirForFrame({ principal: 'user-x' }), profileDirForFrame({ principal: 'user-x' }))
  assert.notEqual(profileDirForFrame({ principal: 'user-x' }, 900), profileDirForFrame({ principal: 'user-x' }, 901))
})

test('a principal can never name a directory outside the agent browser folder', () => {
  const hostile = ['..', '.', '../..', '../../etc', '/etc/passwd', 'a\\..\\b', 'C:\\Windows', '\u0000', 'nul', 'COM1', 'con.txt', ' ', '\n', '~', '%2e%2e']
  for (const p of hostile) {
    const dir = profileDirForFrame({ principal: p })
    assert.equal(dirname(dir), join(ROOT, '900', 'browser'), `${JSON.stringify(p)} stays directly under browser/`)
    const name = basename(dir)
    assert.ok(name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\'), `${JSON.stringify(p)} gave ${name}`)
    assert.ok(!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/.test(name), `${JSON.stringify(p)} gave a Windows device name ${name}`)
    assert.ok(name.length <= 64, `${name} is short enough for a deep Chrome profile path`)
  }
})

test('readFramePrincipal: absent is the owner, a present value is used exactly, an unreadable one is refused', () => {
  assert.deepEqual(readFramePrincipal({}), { ok: true, principal: 'owner', fallback: true })
  assert.deepEqual(readFramePrincipal({ principal: undefined }), { ok: true, principal: 'owner', fallback: true })
  assert.deepEqual(readFramePrincipal({ principal: ' user-X ' }), { ok: true, principal: ' user-X ', fallback: false })
  // Falling back to the owner for any of these would be the leak.
  for (const bad of [null, '', 0, 42, {}, [], true, 'x'.repeat(257)]) {
    const r = readFramePrincipal({ principal: bad })
    assert.equal(r.ok, false, `principal ${JSON.stringify(bad)} is refused`)
  }
})

test('a frame whose principal cannot be read is refused and launches nothing', async () => {
  const { pool, launched } = fakePool()
  const relay = relayOver(pool)
  const answer = await relay.relay({ clientId: 'c1', assistantId: 900, principal: null, message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://x.test' } } } })
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'bad_frame')
  assert.equal(launched.length, 0, 'no browser, least of all the owner one')
  relay.close()
})

// ── 2. The relay door ────────────────────────────────────────────────────────

test('relay: initialize, ping, tools/list and a notification, as the desktop answers them', async () => {
  const { pool } = fakePool()
  const relay = relayOver(pool)
  const init = await relay.relay({ clientId: 'c1', assistantId: 900, message: { jsonrpc: '2.0', id: 'i', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'shim', version: '1' } } } })
  assert.equal(init.ok, true)
  assert.equal(init.message.id, 'i')
  assert.equal(init.message.result.protocolVersion, '2025-06-18')
  assert.deepEqual(init.message.result.capabilities, { tools: {} })
  assert.equal(init.message.result.serverInfo.name, 'hoai-agent-browser')
  assert.match(init.message.result.instructions, /your own browser host on test-box/)
  const note = await relay.relay({ clientId: 'c1', assistantId: 900, message: { jsonrpc: '2.0', method: 'notifications/initialized' } })
  assert.deepEqual(note, { ok: true, message: {} })
  const ping = await relay.relay({ clientId: 'c1', assistantId: 900, message: { jsonrpc: '2.0', id: 2, method: 'ping' } })
  assert.deepEqual(ping.message.result, {})
  const list = await relay.relay({ clientId: 'c1', assistantId: 900, message: { jsonrpc: '2.0', id: 3, method: 'tools/list' } })
  assert.deepEqual(
    list.message.result.tools.map((t: any) => t.name),
    ['hoai_browser_open_session', 'hoai_browser_close_session', 'hoai_browser_status', 'hoai_browser_wait_gate', 'browser_navigate'],
  )
  relay.close()
})

test('relay: a clientId stays bound to its assistant, and malformed frames are refused', async () => {
  const { pool } = fakePool()
  const relay = relayOver(pool)
  const msg = { jsonrpc: '2.0', id: 1, method: 'ping' }
  assert.equal((await relay.relay({ clientId: 'c1', assistantId: 900, message: msg })).ok, true)
  const other = await relay.relay({ clientId: 'c1', assistantId: 901, message: msg })
  assert.equal(other.ok, false)
  assert.match(other.error.message, /another agent/)
  for (const bad of [
    { assistantId: 900, message: msg },
    { clientId: 'c2', message: msg },
    { clientId: 'c2', assistantId: 900 },
    { clientId: 'c2', assistantId: 900, message: { jsonrpc: '1.0', id: 1, method: 'ping' } },
    { clientId: 'c2', assistantId: 900, message: { jsonrpc: '2.0', id: 1 } },
  ]) {
    const answer = await relay.relay(bad)
    assert.equal(answer.ok, false, JSON.stringify(bad))
    assert.equal(answer.error.code, 'bad_frame')
  }
  relay.close()
})

test('relay: session tools answer for this host, unknown and never-exposed tools are refused, wait_seconds never reaches the engine', async () => {
  const { pool, calls } = fakePool()
  const relay = relayOver(pool)
  const call = async (name: string, args: Record<string, unknown> = {}, principal = 'user-a') =>
    (await relay.relay({ clientId: 'c1', assistantId: 900, principal, message: { jsonrpc: '2.0', id: name + Math.random(), method: 'tools/call', params: { name, arguments: args } } })).message.result
  assert.match(textOf({ ok: true, message: { result: await call('hoai_browser_status') } }), /No browser session is open/)
  assert.match(textOf({ ok: true, message: { result: await call('hoai_browser_open_session', { purpose: 'Check the seat map', profile: 'preview' }) } }), /open on test-box.*no separate preview profile/s)
  assert.match(textOf({ ok: true, message: { result: await call('hoai_browser_status') } }), /Purpose: Check the seat map/)
  await call('browser_navigate', { url: 'https://x.test', wait_seconds: 600 })
  assert.deepEqual(calls.at(-1)?.args, { url: 'https://x.test' }, 'wait_seconds is stripped before the engine')
  const never = await call('browser_cookie_list')
  assert.equal(never.isError, true)
  assert.match(never.content[0].text, /Unknown tool "browser_cookie_list"/)
  const gate = await call('hoai_browser_wait_gate', { gate_id: 'g1' })
  assert.equal(gate.isError, true)
  assert.match(gate.content[0].text, /raises no permission gates/)
  assert.match(textOf({ ok: true, message: { result: await call('hoai_browser_close_session') } }), /Session closed/)
  assert.match(textOf({ ok: true, message: { result: await call('hoai_browser_close_session') } }), /No session was open/)
  relay.close()
})

test('relay: no installed browser is a clear tool error, not a crash', async () => {
  const pool = new BrowserPool({
    agentRoot: ROOT,
    createEngine: () => {
      throw new HostError('browser_not_installed', browserNotFoundMessage({ via: 'search', tried: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] }))
    },
  })
  const relay = relayOver(pool)
  const answer = await relay.relay({ clientId: 'c1', assistantId: 900, message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://x.test' } } } })
  assert.equal(answer.ok, true, 'the call is answered, as a tool error the agent reads')
  assert.equal(answer.message.result.isError, true)
  assert.match(answer.message.result.content[0].text, /browser_not_installed: No installed Chrome or Chromium was found on this machine/)
  relay.close()
})

// ── 3. The wire to the backend ───────────────────────────────────────────────

test('handshake: the token rides in the query, role, agents and label in the auth', () => {
  const opts = handshakeOptions({ token: 'tok', assistantIds: [900, 901] }, 'kc-server')
  assert.deepEqual(opts, { query: { pairingToken: 'tok' }, auth: { role: 'browser_host', agents: [900, 901], deviceLabel: 'kc-server' } })
  assert.equal(BROWSER_HOST_ROLE, 'browser_host')
})

test('readPairings: one entry per pairing, listing only that pairing agents, never a token in a reason', () => {
  const files: Record<string, unknown> = {
    'credentials.json': { backendUrl: 'https://api.test/api/v1', pairingToken: 'tokA', pairingId: 39, assistantId: 900 },
    'credentials-900.json': { backendUrl: 'https://api.test/api/v1', pairingToken: 'tokA', pairingId: 39, assistantId: 900, pairedAt: '2026-09-01T00:00:00Z' },
    'credentials-905.json': { backendUrl: 'https://api.test/api/v1', pairingToken: 'tokA', pairingId: 39, assistantId: 905, pairedAt: '2026-09-01T00:00:00Z' },
    'credentials-901.json': { backendUrl: 'https://api.test/api/v1/', pairingToken: 'tokB', pairingId: 68, assistantId: 901 },
    'credentials-902.json': { backendUrl: 'https://api.test', pairingToken: 'tokOld', pairingId: 70, assistantId: 902, pairedAt: '2026-08-01T00:00:00Z' },
    'credentials-903.json': { backendUrl: 'https://api.test', pairingToken: 'tokNew', pairingId: 70, assistantId: 903, pairedAt: '2026-09-10T00:00:00Z' },
    'credentials-904.json': { backendUrl: 'https://api.test', pairingToken: 'secret-tok', pairingId: 71, assistantId: 999 },
    'credentials-906.json': { backendUrl: 'https://api.test', pairingId: 72, assistantId: 906 },
    'credentials-907.json.lock': {},
    'notes.txt': {},
  }
  const read = (allow: Set<number> | null = null) =>
    readPairings({
      agentRoot: '/x',
      allow,
      listDir: () => Object.keys(files),
      readText: (p: string) => JSON.stringify(files[basename(p)]),
    })
  const { pairings, skipped } = read()
  const byId = new Map(pairings.map((p: any) => [p.pairingId, p]))
  assert.deepEqual([...byId.keys()].sort((a: any, b: any) => a - b), [39, 68, 70])
  assert.deepEqual(byId.get(39).assistantIds, [900, 905], 'the legacy file and the per-agent file are one agent')
  assert.deepEqual(byId.get(68).assistantIds, [901])
  assert.equal(byId.get(68).backendUrl, 'https://api.test')
  assert.equal(byId.get(70).token, 'tokNew', 'a rotation leftover loses to the newest pairing')
  assert.equal(byId.get(70).staleTokens, 1)
  assert.deepEqual(skipped.map((s: any) => s.file).sort(), ['credentials-904.json', 'credentials-906.json'])
  assert.ok(!JSON.stringify(skipped).includes('secret-tok'), 'no token in a skip reason')
  assert.deepEqual(read(new Set([905])).pairings.map((p: any) => p.assistantIds), [[905]], 'HOAI_BROWSER_HOST_AGENTS narrows the list')
})

test('the host opens one socket per pairing, each listing only its own agents, and answers on the socket the frame came in on', { timeout: 60_000 }, async () => {
  const relayA = await startFakeRelay({ token: 'tokA', admissible: [900, 905] })
  const relayB = await startFakeRelay({ token: 'tokB', admissible: [901] })
  const root = mkdtempSync(join(tmpdir(), 'bh-host-'))
  writeFileSync(join(root, 'credentials-900.json'), JSON.stringify({ backendUrl: relayA.backendUrl, pairingToken: 'tokA', pairingId: 39, assistantId: 900 }))
  writeFileSync(join(root, 'credentials-905.json'), JSON.stringify({ backendUrl: relayA.backendUrl, pairingToken: 'tokA', pairingId: 39, assistantId: 905 }))
  writeFileSync(join(root, 'credentials-901.json'), JSON.stringify({ backendUrl: relayB.backendUrl, pairingToken: 'tokB', pairingId: 68, assistantId: 901 }))
  const { factory, launched } = fakeEngines()
  const host = new BrowserHost({ agentRoot: root, env: {}, deviceLabel: 'kc-server', browserTools: [navigateTool()], createEngine: factory, rescanMs: 60_000 }).start()
  try {
    const sockA = await relayA.waitForHost()
    const sockB = await relayB.waitForHost()
    assert.equal(relayA.handshakes.length, 1)
    assert.equal(relayB.handshakes.length, 1)
    assert.deepEqual(relayA.handshakes[0].auth, { role: 'browser_host', agents: [900, 905], deviceLabel: 'kc-server' })
    assert.deepEqual(relayB.handshakes[0].auth, { role: 'browser_host', agents: [901], deviceLabel: 'kc-server' })
    assert.equal(relayA.handshakes[0].query.pairingToken, 'tokA')
    assert.equal(relayB.handshakes[0].query.pairingToken, 'tokB')

    const { frame, post } = await relayA.rpc(sockA, {
      assistantId: 905,
      clientId: 'shim-1',
      principal: 'user-user_2Alice',
      message: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://example.com' } } },
    })
    assert.ok(post, 'the result was posted and accepted')
    assert.equal(post.status, 200)
    assert.equal(post.headers['x-bgos-pairing'], 'tokA', 'posted with the same pairing token')
    assert.equal(post.body.socketId, sockA.id, 'naming the socket the frame arrived on')
    assert.equal(post.body.ok, true)
    assert.equal(post.body.message.id, 7)
    assert.equal(relayA.postsFor(String(frame.rpcId)).length, 1, 'posted once')
    assert.equal(launched[0], join(root, '905', 'browser', principalDirName('user-user_2Alice')))

    // A notification is never posted: the backend settled it on send.
    const note = await relayA.rpc(sockA, { assistantId: 900, clientId: 'shim-1b', message: { jsonrpc: '2.0', method: 'notifications/initialized' } }, 1_500)
    assert.equal(note.post, null)
    assert.equal(relayA.postsFor(String(note.frame.rpcId)).length, 0)

    // A frame for an agent this pairing does not serve is answered, refused.
    const stray = await relayB.rpc(sockB, { assistantId: 900, clientId: 'shim-2', message: { jsonrpc: '2.0', id: 1, method: 'ping' } })
    assert.ok(stray.post)
    assert.equal(stray.post.body.ok, false)
    assert.equal(stray.post.body.error.code, 'bad_frame')
    assert.equal(stray.post.headers['x-bgos-pairing'], 'tokB')
  } finally {
    await host.stop()
    await relayA.close()
    await relayB.close()
  }
})

test('a socket the backend refuses is retried on a backoff, not dropped for good', { timeout: 30_000 }, async () => {
  const relay = await startFakeRelay({ token: 'tok', admissible: [] })
  const { pool } = fakePool()
  const conn = new PairingConnection({
    pairing: { key: 'k', pairingId: 1, backendUrl: relay.url, token: 'tok', assistantIds: [900] },
    deviceLabel: 'box',
    relay: relayOver(pool),
    retryMinMs: 50,
    retryMaxMs: 200,
  }).start()
  try {
    const deadline = Date.now() + 10_000
    while (relay.handshakes.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    assert.ok(relay.handshakes.length >= 3, `retried after refusals: ${relay.handshakes.length} handshakes`)
    assert.ok(relay.handshakes.every((h) => h.refused))
  } finally {
    conn.stop()
    await relay.close()
  }
})

test('resultBody and resultUrl match the backend route and DTO limits', () => {
  assert.equal(resultUrl('https://api.test/api/v1/', 'a b'), 'https://api.test/api/v1/browser/rpc/a%20b/result')
  assert.deepEqual(resultBody('s1', { ok: true, message: { id: 1 } }), { socketId: 's1', ok: true, message: { id: 1 } })
  const long = resultBody('s1', { ok: false, error: { code: 'x'.repeat(100), message: 'y'.repeat(5000) } })
  assert.equal((long as any).error.code.length, 64)
  assert.equal((long as any).error.message.length, 2000)
})

test('relay: ids 1 and "1" in flight together each get their own answer', async () => {
  const { factory } = fakeEngines({ callDelayMs: 50 })
  const relay = relayOver(new BrowserPool({ agentRoot: ROOT, createEngine: factory }))
  const call = (id: unknown) =>
    relay.relay({ clientId: 'c1', assistantId: 900, principal: 'user-a', message: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: `https://x.test/${typeof id}` } } } })
  const [numeric, text] = await Promise.all([call(1), call('1')])
  assert.equal(numeric.ok, true)
  assert.equal(text.ok, true)
  assert.equal(numeric.message.id, 1)
  assert.equal(text.message.id, '1')
  relay.close()
})

test('the pool: stopping during a launch waits for it and stops the browser it started', async () => {
  const { factory, stops } = fakeEngines({ startDelayMs: 100 })
  const pool = new BrowserPool({ agentRoot: ROOT, createEngine: factory })
  const acquiring = pool.acquire({ assistantId: 900, principal: 'user-a' }).catch(() => null)
  await new Promise((r) => setTimeout(r, 10))
  await pool.stopAll()
  await acquiring
  assert.equal(stops.length, 1, 'the browser that finished launching after the stop was stopped')
  assert.deepEqual(pool.running(), [])
})

test('postResult: a 5xx or a network failure is retried, a 4xx is final', { timeout: 30_000 }, async () => {
  const run = async (answers: Array<number | 'throw'>) => {
    const seen: number[] = []
    const fetchImpl = async () => {
      const next = answers[seen.length] ?? 200
      seen.push(seen.length)
      if (next === 'throw') throw new Error('ECONNRESET')
      return { ok: next >= 200 && next < 300, status: next } as Response
    }
    const conn = new PairingConnection({ pairing: { key: 'k', pairingId: 1, backendUrl: 'https://api.test', token: 'tok', assistantIds: [900] }, deviceLabel: 'box', relay: null as any, fetchImpl: fetchImpl as any })
    const result = await conn.postResult('rpc-1', { socketId: 's', ok: true, message: {} })
    return { result, calls: seen.length }
  }
  assert.deepEqual(await run([503, 200]), { result: { accepted: true, status: 200 }, calls: 2 })
  assert.deepEqual(await run(['throw', 200]), { result: { accepted: true, status: 200 }, calls: 2 })
  assert.deepEqual(await run([404]), { result: { accepted: false, status: 404 }, calls: 1 }, 'a 404 is the backend saying no; never re-posted')
  assert.deepEqual(await run([400]), { result: { accepted: false, status: 400 }, calls: 1 })
})

test('the answer names the socket the frame ARRIVED on, even when the socket reconnects before the answer', async () => {
  const socket = Object.assign(new EventEmitter(), { id: 'socket-at-arrival', connect() {}, disconnect() {} })
  const posted: any[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const relay = { relay: async () => (await gate, { ok: true, message: { jsonrpc: '2.0', id: 1, result: {} } }) }
  const conn = new PairingConnection({
    pairing: { key: 'k', pairingId: 1, backendUrl: 'https://api.test', token: 'tok', assistantIds: [900] },
    deviceLabel: 'box',
    relay: relay as any,
    io: (() => socket) as any,
    fetchImpl: (async (_url: string, init: any) => {
      posted.push(JSON.parse(init.body))
      return { ok: true, status: 200 }
    }) as any,
  }).start()
  socket.emit('browser_rpc', { rpcId: 'r1', clientId: 'c', assistantId: 900, message: { jsonrpc: '2.0', id: 1, method: 'ping' } })
  socket.id = 'socket-after-reconnect'
  release()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(posted.length, 1)
  assert.equal(posted[0].socketId, 'socket-at-arrival')
  conn.stop()
})

test('Chrome is launched with the allow-listed environment only (the list itself: test/browser-env.test.ts)', async () => {
  const env = { PATH: '/usr/bin', HOME: '/h', DISPLAY: ':0', XAUTHORITY: '/x', LANG: 'en_US.UTF-8', SSH_AUTH_SOCK: '/tmp/agent.sock', HOAI_BROWSER_HOST_PAIRING_TOKEN: 'pair-secret', BGOS_API_KEY: 'k1', OPENAI_API_KEY: 'k2', GITHUB_TOKEN: 'k3' }
  assert.deepEqual(chromeEnv(env, { platform: 'linux', headed: false }), { PATH: '/usr/bin', HOME: '/h', LANG: 'en_US.UTF-8' })
  let seen: any = null
  const fakeChrome = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), pid: 1, kill() {} })
  const launched = launchChromium({
    executable: '/c',
    profileDir: '/p',
    env,
    spawnImpl: ((_cmd: string, _args: string[], options: any) => {
      seen = options
      return fakeChrome
    }) as any,
  })
  fakeChrome.stderr.emit('data', Buffer.from('DevTools listening on ws://127.0.0.1:1/devtools/browser/x\n'))
  await launched
  assert.ok(!Object.values(seen.env).includes('pair-secret'), 'the pairing token never reaches Chrome')
  assert.ok(!('SSH_AUTH_SOCK' in seen.env), 'nor the ssh-agent socket')
  assert.ok(!Object.values(seen.env).some((v) => ['k1', 'k2', 'k3'].includes(String(v))))
})

test('scoping: a daemon-started host serves its own pairing and agent, never another pairing on the machine', () => {
  const scope = scopeFromEnv({ HOAI_BROWSER_HOST_PAIRING_TOKEN: 'tokA', HOAI_BROWSER_HOST_BACKEND_URL: 'https://api.test/api/v1', HOAI_BROWSER_HOST_ASSISTANT_ID: '905', HOAI_BROWSER_HOST_PARENT_PID: '123' })
  assert.deepEqual(scope, { token: 'tokA', backendUrl: 'https://api.test', assistantId: 905, parentPid: 123 })
  assert.equal(scopeFromEnv({}), null, 'run by hand: every pairing')
  const onDisk = [
    { key: 'a', pairingId: 39, backendUrl: 'https://api.test', token: 'tokA', staleTokens: 0, assistantIds: [900] },
    { key: 'b', pairingId: 68, backendUrl: 'https://api.test', token: 'tokB', staleTokens: 0, assistantIds: [901] },
  ]
  const scoped = scopePairings(onDisk, scope)
  assert.equal(scoped.length, 1)
  assert.equal(scoped[0].token, 'tokA')
  assert.deepEqual(scoped[0].assistantIds, [900, 905], 'its pairing agents on disk plus its own')
  assert.deepEqual(scopePairings(onDisk, null), onDisk)
  const envOnly = scopePairings([onDisk[1]], scope)
  assert.equal(envOnly.length, 1, 'a daemon paired through its environment, with no file on disk')
  assert.equal(envOnly[0].token, 'tokA')
  assert.deepEqual(envOnly[0].assistantIds, [905])
  assert.deepEqual(scopePairings([onDisk[1]], { ...scope, assistantId: null }), [], 'nothing to serve without its agent')
})

test('the browser_ roster is loaded on first use, once, and a failed load is retried', async () => {
  let loads = 0
  let fail = true
  const core = new BrowserHostCore({
    pool: fakePool().pool,
    deviceLabel: 'box',
    browserTools: async () => {
      loads += 1
      if (fail) throw new Error('playwright-core missing')
      return [navigateTool()]
    },
  })
  assert.equal(loads, 0, 'nothing loaded before a frame')
  await assert.rejects(core.roster(), /playwright-core missing/)
  fail = false
  assert.equal((await core.roster()).length, 5)
  await core.roster()
  assert.equal(loads, 2, 'loaded once after the failure, then cached')
})

// ── 4. The roster and the browser ────────────────────────────────────────────

test('the roster is the desktop one: four session tools, Playwright tools minus the never set, wait_seconds where a gate could rise', { timeout: 60_000 }, async () => {
  const tools = servedBrowserTools(await listTools({ caps: DEFAULT_CAPS, outputDir: mkdtempSync(join(tmpdir(), 'bh-out-')) }))
  const names = tools.map((t: any) => t.name)
  assert.ok(names.includes('browser_navigate') && names.includes('browser_snapshot') && names.includes('browser_pdf_save'))
  assert.ok(!names.some((n: string) => NEVER_TOOLS.has(n)), 'no never-exposed tool')
  const byName = new Map<string, any>(tools.map((t: any) => [t.name, t]))
  assert.ok(byName.get('browser_click').inputSchema.properties.wait_seconds, 'a write carries wait_seconds')
  assert.ok(!byName.get('browser_snapshot').inputSchema.properties.wait_seconds, 'a read does not')
  assert.deepEqual(SESSION_TOOLS.map((t: any) => t.name), ['hoai_browser_open_session', 'hoai_browser_close_session', 'hoai_browser_status', 'hoai_browser_wait_gate'])
  assert.ok(!/[\u2013\u2014]/.test(hostInstructions('box')), 'the instructions are dash free')
})

test('resolveChromeExecutable: an installed browser is found, none is said plainly, and nothing is downloaded', () => {
  const mac = chromeCandidates({ platform: 'darwin', env: {}, home: '/Users/kc' })
  assert.equal(mac[0], '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  assert.ok(mac.includes('/Users/kc/Applications/Chromium.app/Contents/MacOS/Chromium'))
  const linux = chromeCandidates({ platform: 'linux', env: { PATH: '/usr/local/bin:/usr/bin' }, home: '/home/kc' })
  assert.equal(linux[0], '/usr/local/bin/google-chrome')
  assert.ok(linux.includes('/usr/bin/chromium'))
  const win = chromeCandidates({ platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\kc\\AppData\\Local' }, home: 'C:\\Users\\kc' })
  assert.ok(win.some((p: string) => p.endsWith(join('Google', 'Chrome', 'Application', 'chrome.exe'))))

  const found = resolveChromeExecutable({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: (p: any) => p === '/usr/bin/chromium' })
  assert.equal(found.path, '/usr/bin/chromium')
  const none = resolveChromeExecutable({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: () => false })
  assert.equal(none.path, null)
  const msg = browserNotFoundMessage(none)
  assert.match(msg, /No installed Chrome or Chromium was found on this machine/)
  assert.match(msg, /never downloads a browser/)
  assert.match(msg, /\/usr\/bin\/google-chrome/)
  const override = resolveChromeExecutable({ platform: 'linux', env: { HOAI_BROWSER_EXECUTABLE: '/opt/x/chrome' }, exists: () => false })
  assert.equal(override.path, null)
  assert.match(browserNotFoundMessage(override), /HOAI_BROWSER_EXECUTABLE is set to \/opt\/x\/chrome, which does not exist/)
})

test('a Snap Chromium is skipped on linux, and the message says why', () => {
  assert.equal(isSnapChromium('/snap/bin/chromium'), true)
  assert.equal(isSnapChromium('/usr/bin/chromium-browser', () => '#!/bin/sh\nexec /snap/bin/chromium "$@"\n'), true)
  assert.equal(isSnapChromium('/usr/bin/chromium', () => '\u007fELF\u0002\u0001', (p: string) => p), false)
  assert.equal(isSnapChromium('/usr/bin/chromium', () => '\u007fELF\u0002\u0001', () => '/snap/chromium/current/usr/lib/chromium/chrome'), true, 'a link into /snap is a Snap too')
  const snapOnly = resolveChromeExecutable({
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    exists: (p: any) => p === '/usr/bin/chromium-browser',
    isSnap: (p: any) => p === '/usr/bin/chromium-browser',
  })
  assert.equal(snapOnly.path, null)
  assert.match(browserNotFoundMessage(snapOnly), /Skipped \/usr\/bin\/chromium-browser: a Snap Chromium cannot open a profile under ~\/.bgos-agent/)
  const both = resolveChromeExecutable({
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    exists: (p: any) => p === '/usr/bin/chromium-browser' || p === '/opt/google/chrome/chrome',
    isSnap: (p: any) => p === '/usr/bin/chromium-browser',
  })
  assert.equal(both.path, '/opt/google/chrome/chrome', 'a usable Chrome behind a Snap one is still found')
})

test('chromeArgs: remote debugging on a free port, the profile as the user data dir, headless unless asked', () => {
  const args = chromeArgs({ profileDir: '/p/owner', headless: true, platform: 'linux' })
  assert.ok(args.includes('--remote-debugging-port=0'))
  assert.ok(args.includes('--user-data-dir=/p/owner'))
  assert.ok(args.includes('--headless=new'))
  assert.ok(!chromeArgs({ profileDir: '/p/owner', headless: false, platform: 'darwin' }).includes('--headless=new'))
})

test('readDevToolsActivePort: only a well formed endpoint is reattached to', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bh-port-'))
  assert.equal(readDevToolsActivePort(dir), null)
  writeFileSync(join(dir, 'DevToolsActivePort'), '9222\n/devtools/browser/abc-123\n')
  assert.equal(readDevToolsActivePort(dir), 'ws://127.0.0.1:9222/devtools/browser/abc-123')
  writeFileSync(join(dir, 'DevToolsActivePort'), 'nope\n/devtools/browser/abc\n')
  assert.equal(readDevToolsActivePort(dir), null)
})

// ── 5. The real process ──────────────────────────────────────────────────────

const nodeOnPath = spawnSync('node', ['--version']).status === 0

test('the host process stays up with no live socket: no credentials yet, or refused by the gateway', { timeout: 60_000, skip: nodeOnPath ? false : 'node is not on PATH' }, async () => {
  if (!nodeOnPath) return
  // Exits are recorded from the moment of spawn, so a host that died before a
  // wait began still reads as exited, never as alive.
  const exits = new Map<ReturnType<typeof spawn>, number | null>()
  const track = (child: ReturnType<typeof spawn>) => (child.once('exit', (code) => exits.set(child, code)), child)
  const waitExit = async (child: ReturnType<typeof spawn>, ms: number): Promise<number | null | 'alive'> => {
    const deadline = Date.now() + ms
    while (!exits.has(child) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    return exits.has(child) ? exits.get(child)! : 'alive'
  }
  // No credentials at all: it waits for a pairing instead of exiting.
  const empty = mkdtempSync(join(tmpdir(), 'bh-empty-'))
  const idle = track(spawn('node', [HOST_BIN], { env: { ...process.env, HOME: empty, USERPROFILE: empty }, stdio: 'ignore' }))
  // Refused by the gateway: it waits out its backoff instead of exiting.
  const relay = await startFakeRelay({ token: 'tok-refused', admissible: [] })
  const refusedHome = mkdtempSync(join(tmpdir(), 'bh-refused-'))
  const refused = track(
    spawn('node', [HOST_BIN], {
      env: { ...process.env, HOME: refusedHome, USERPROFILE: refusedHome, HOAI_BROWSER_HOST_PAIRING_TOKEN: 'tok-refused', HOAI_BROWSER_HOST_BACKEND_URL: relay.backendUrl, HOAI_BROWSER_HOST_ASSISTANT_ID: '900' },
      stdio: 'ignore',
    }),
  )
  try {
    const deadline = Date.now() + 20_000
    while (!relay.handshakes.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    assert.equal(relay.handshakes[0]?.refused, true, 'the gateway refused it')
    assert.equal(await waitExit(idle, 2_500), 'alive', 'a host with no pairing yet stays up')
    assert.equal(await waitExit(refused, 1_000), 'alive', 'a refused host stays up for its retry')
    idle.kill('SIGTERM')
    refused.kill('SIGTERM')
    assert.equal(await waitExit(idle, 10_000), 0, 'and still stops cleanly on SIGTERM')
    assert.equal(await waitExit(refused, 10_000), 0)
  } finally {
    idle.kill('SIGKILL')
    refused.kill('SIGKILL')
    await relay.close()
  }
})

test('a daemon-started host connects only its daemon pairing, even with another pairing on disk', { timeout: 60_000, skip: nodeOnPath ? false : 'node is not on PATH' }, async () => {
  if (!nodeOnPath) return
  const mine = await startFakeRelay({ token: 'tok-mine', admissible: [900, 905] })
  const other = await startFakeRelay({ token: 'tok-other', admissible: [901] })
  const home = mkdtempSync(join(tmpdir(), 'bh-scope-'))
  const agentRoot = join(home, '.bgos-agent')
  mkdirSync(agentRoot, { recursive: true })
  writeFileSync(join(agentRoot, 'credentials-900.json'), JSON.stringify({ backendUrl: mine.backendUrl, pairingToken: 'tok-mine', pairingId: 1, assistantId: 900 }))
  writeFileSync(join(agentRoot, 'credentials-901.json'), JSON.stringify({ backendUrl: other.backendUrl, pairingToken: 'tok-other', pairingId: 2, assistantId: 901 }))
  const host = spawn('node', [HOST_BIN], {
    env: { ...process.env, HOME: home, USERPROFILE: home, HOAI_BROWSER_HOST_PAIRING_TOKEN: 'tok-mine', HOAI_BROWSER_HOST_BACKEND_URL: mine.backendUrl, HOAI_BROWSER_HOST_ASSISTANT_ID: '905' },
    stdio: 'ignore',
  })
  try {
    await mine.waitForHost(30_000)
    assert.deepEqual(mine.handshakes[0].auth.agents, [900, 905], 'its pairing agent on disk, and its own')
    await new Promise((r) => setTimeout(r, 2_000))
    assert.equal(other.handshakes.length, 0, 'the other pairing on this machine is left to its own daemon')
  } finally {
    host.kill('SIGTERM')
    await mine.close()
    await other.close()
  }
})

// ── 6. A real Chromium, driven through real browser_rpc frames ───────────────

const chrome = resolveChromeExecutable()
const nodeOk = spawnSync('node', ['--version']).status === 0
const e2eSkip = !chrome.path ? 'no Chrome or Chromium is installed on this machine' : !nodeOk ? 'node is not on PATH' : false

test(
  'END TO END: the host process, a real Chromium and the fake relay; one principal never sees another cookie, and keeps its own across a restart',
  { timeout: 180_000, skip: e2eSkip },
  async () => {
    if (e2eSkip) return // bun ignores the skip option; this is the same skip
    const site = await startCookieSite()
    const relay = await startFakeRelay({ token: 'tok-e2e', admissible: [900] })
    const home = mkdtempSync(join(tmpdir(), 'bh-e2e-'))
    const agentRoot = join(home, '.bgos-agent')
    mkdirSync(agentRoot, { recursive: true })
    writeFileSync(join(agentRoot, 'credentials-900.json'), JSON.stringify({ backendUrl: relay.backendUrl, pairingToken: 'tok-e2e', pairingId: 5, assistantId: 900 }))
    const logs: string[] = []
    const child = spawn('node', [HOST_BIN], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.on('data', (c: Buffer) => logs.push(c.toString()))
    try {
      const sock = await relay.waitForHost(30_000)
      assert.deepEqual(relay.handshakes[0].auth, { role: 'browser_host', agents: [900], deviceLabel: relay.handshakes[0].auth.deviceLabel })
      assert.equal(relay.handshakes[0].query.pairingToken, 'tok-e2e')
      let id = 0
      const rpc = async (principal: string | undefined, message: Record<string, unknown>) => {
        const req = { assistantId: 900, clientId: 'shim-e2e', message, ...(principal === undefined ? {} : { principal }) }
        const { post } = await relay.rpc(sock, req, 90_000)
        assert.ok(post, `answered and accepted: ${JSON.stringify(message).slice(0, 120)}\n${logs.join('')}`)
        assert.equal(post.status, 200)
        assert.equal(post.headers['x-bgos-pairing'], 'tok-e2e')
        assert.equal(post.body.socketId, sock.id)
        assert.equal(post.body.ok, true, JSON.stringify(post.body))
        return post.body.message
      }
      const tool = async (principal: string | undefined, name: string, args: Record<string, unknown> = {}) => {
        const response = await rpc(principal, { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
        // Session tool results carry no isError at all, as on the desktop.
        assert.notEqual(response.result.isError, true, JSON.stringify(response))
        return response.result.content.map((c: any) => c.text ?? '').join('\n')
      }
      const cookieSeenBy = async (principal: string | undefined) => {
        await tool(principal, 'browser_navigate', { url: `${site.url}/show` })
        return tool(principal, 'browser_evaluate', { function: "() => document.querySelector('h1').textContent" })
      }

      const init = await rpc('user-user_2Alice', { jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hoai-browser-mcp', version: '0.44.0' } } })
      assert.equal(init.result.serverInfo.name, 'hoai-agent-browser')
      const list = await rpc('user-user_2Alice', { jsonrpc: '2.0', id: ++id, method: 'tools/list' })
      assert.equal(list.result.tools.length, 28, 'the desktop roster: 4 session tools and 24 browser_ tools')

      // Alice signs in (a persistent cookie), and her browser sends it back.
      await tool('user-user_2Alice', 'browser_navigate', { url: `${site.url}/set?v=alice` })
      assert.match(await cookieSeenBy('user-user_2Alice'), /cookie: who=alice/)
      // Bob, same agent, is another person: his browser has never seen it.
      const bobFirst = await cookieSeenBy('user-user_2Bob')
      assert.match(bobFirst, /cookie: none/, `Bob must not receive Alice's cookie: ${bobFirst}`)
      assert.doesNotMatch(bobFirst, /alice/)
      await tool('user-user_2Bob', 'browser_navigate', { url: `${site.url}/set?v=bob` })
      assert.match(await cookieSeenBy('user-user_2Bob'), /cookie: who=bob/)
      // A frame with no principal is the owner's, a third profile.
      assert.match(await cookieSeenBy(undefined), /cookie: none/)
      // Alice's browser closes and reopens: her login is on disk, still hers.
      assert.match(await tool('user-user_2Alice', 'hoai_browser_close_session'), /Session closed/)
      assert.match(await cookieSeenBy('user-user_2Alice'), /cookie: who=alice/)

      const browserDir = join(agentRoot, '900', 'browser')
      const profiles = readdirSync(browserDir).sort()
      assert.deepEqual(profiles, ['owner', principalDirName('user-user_2Alice'), principalDirName('user-user_2Bob')].sort())
      for (const p of profiles) assert.ok(existsSync(join(browserDir, p, 'Local State')), `${p} is a real Chrome profile`)
      assert.equal(site.hits.filter((h) => h.includes('who=alice')).length >= 2, true)
    } finally {
      child.kill('SIGTERM')
      await new Promise((r) => (child.exitCode !== null ? r(null) : child.once('exit', r)))
      await relay.close()
      site.server.close()
    }
    // No Chrome is left running on any of these profiles. Chrome's helper
    // processes can take a moment to follow the browser out, so poll.
    let left = ''
    for (let i = 0; i < 50; i++) {
      left = spawnSync('pgrep', ['-f', home], { encoding: 'utf8' }).stdout.trim()
      if (!left) break
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.equal(left, '', `no browser left behind: ${left}`)
  },
)

// ── helpers ──────────────────────────────────────────────────────────────────

function navigateTool() {
  return { name: 'browser_navigate', description: 'Navigate', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } }
}

function fakeEngines({ startDelayMs = 0, callDelayMs = 0 } = {}) {
  const launched: string[] = []
  const stops: string[] = []
  const calls: Array<{ profileDir: string; name: string; args: any }> = []
  const factory = ({ profileDir }: { profileDir: string }) => {
    launched.push(profileDir)
    return {
      alive: false,
      onGone: null,
      async start() {
        if (startDelayMs) await new Promise((r) => setTimeout(r, startDelayMs))
        this.alive = true
      },
      pages() {
        return [{ url: () => 'https://x.test/', title: async () => 'X' }]
      },
      async callTool(name: string, args: any) {
        calls.push({ profileDir, name, args })
        if (callDelayMs) await new Promise((r) => setTimeout(r, callDelayMs))
        return { content: [{ type: 'text', text: `${name} ran in ${profileDir} for ${args?.url ?? ''}` }] }
      },
      async stop() {
        stops.push(profileDir)
        this.alive = false
      },
    }
  }
  return { factory, launched, calls, stops }
}

function fakePool() {
  const { factory, launched, calls } = fakeEngines()
  return { pool: new BrowserPool({ agentRoot: ROOT, createEngine: factory }), launched, calls }
}

function relayOver(pool: any) {
  const core = new BrowserHostCore({ pool, browserTools: [navigateTool()], deviceLabel: 'test-box' })
  return new RelaySessions({ core, serverInfo: { name: 'hoai-agent-browser', version: '0.0.0' }, instructions: hostInstructions('test-box') })
}

function textOf(answer: any): string {
  return (answer?.message?.result?.content ?? []).map((c: any) => c.text ?? '').join('\n')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function startCookieSite() {
  const hits: string[] = []
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    hits.push(`${u.pathname} ${req.headers.cookie ?? ''}`)
    res.setHeader('Content-Type', 'text/html')
    if (u.pathname === '/set') {
      res.setHeader('Set-Cookie', `who=${u.searchParams.get('v')}; Max-Age=3600; Path=/`)
      res.end(`<html><title>set</title><h1>set ${u.searchParams.get('v')}</h1></html>`)
      return
    }
    res.end(`<html><title>show</title><h1>cookie: ${req.headers.cookie ?? 'none'}</h1></html>`)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { server, hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}
