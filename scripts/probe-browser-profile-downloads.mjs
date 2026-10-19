import assert from 'node:assert/strict'
import http from 'node:http'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { BrowserProfileRuntime, profileCrypto } from '../lib/browser-profile-runtime.mjs'
import { createChromiumRtcActivity } from '../lib/browser-profile-rtc-activity.mjs'
import { AgentProfileDownloads } from '../lib/browser-profile-downloads.mjs'
import { AgentProfileArtifacts } from '../lib/browser-profile-artifacts.mjs'
import { createAgentProfileFileArea } from '../lib/browser-profile-file-area.mjs'
import { ensureBrowser } from '../lib/browser-bootstrap.mjs'
import { createManagedProfileEngine } from '../bin/hoai-browser-host.mjs'
const require = createRequire(import.meta.url), { chromium } = require('playwright-core'), { ProfileFileStaging } = require('../lib/browser-profile-core/profile-file-staging.js')
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 1000)
const base = await fs.mkdtemp('/proof/download-native-'); await fs.chmod(base, 0o700)
const report = { kind: 'actual sandboxed managed download hooks', scope: 'Synthetic exact authority and explicit fixture clicks on disposable loopback HTTP. Actual shipped Runtime, Engine, manager and private artifact conversion. No HOAI server, recipient consent or cross-machine release claim.', executable: await ensureBrowser({ findInstalled: () => ({ path: null }) }), cases: [], cleanup: null }
const empty = () => ({ passwordVault: { v: 1, entries: [], neverOrigins: [] }, preferences: { v: 1, searchEngine: 'google' } })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label, timeout = 5000) { const deadline = Date.now() + timeout; while (!await check()) { assert.ok(Date.now() < deadline, label); await delay(5) } }
async function processState(pid) { try { const text = await fs.readFile(`/proc/${pid}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).split(' '); return { pid, group: Number(fields[2]), started: fields[19] } } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error } }
async function groupMembers(group) { const names = await fs.readdir('/proc'); const values = await Promise.all(names.filter(name => /^\d+$/.test(name)).map(name => processState(Number(name)))); return values.filter(value => value?.group === group) }
const roots = []
let failed
try {
  for (const mode of ['normal', 'slow', 'overflow']) {
    const directory = path.join(base, mode); await fs.mkdir(directory, { mode: 0o700 }); const endpoint = profileCrypto.createEndpointIdentity(randomUUID())
    const authority = { profileId: randomUUID(), actingUserId: 'synthetic-download-recipient', assistantId: 42, endpointId: endpoint.identity.endpointId, keyFingerprint: profileCrypto.identityFingerprint(endpoint.identity), bootId: randomUUID(), runtimeId: randomUUID(), sessionId: randomUUID(), writerEpoch: 1, revision: 0, contentKeyEpoch: 1, grantVersion: 1 }
    let runtime, engine, artifacts, staging, manager, server, current = true, admission = false, nativeStop, members = [], ownedBrowserGone = false, cleaned = false, streamClosed = false, scheduledBytes = 0, engineEvents = 0
    const body = Buffer.from('SYNTHETIC_NATIVE_DOWNLOAD_ONLY\n'.repeat(256)), chunks = new Set(), original = () => { assert.equal(current, true); return true }
    try {
      manager = await AgentProfileDownloads.create({ directory: path.join(directory, 'quarantine'), authority, assertCurrent: original, isActive: () => admission && runtime?.state === 'active' && runtime.network === 'active', deadlineMs: mode === 'slow' ? 150 : 10000, observationMs: 5 })
      assert.equal((await fs.stat(manager.directory)).uid, 1000); assert.equal((await fs.stat(manager.directory)).mode & 0o777, 0o700)
      server = http.createServer((request, response) => {
        if (request.url === '/') { response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); response.end('<!doctype html><title>Disposable download fixture</title><a id=download href=/file>Download synthetic file</a>'); return }
        if (request.url !== '/file') { response.writeHead(404); response.end(); return }
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="' + mode + '.txt"', 'cache-control': 'no-store', ...(mode === 'normal' ? { 'content-length': String(body.length) } : {}) })
        response.on('close', () => { streamClosed = true })
        if (mode === 'normal') { scheduledBytes = body.length; response.end(body); return }
        const chunk = Buffer.alloc(mode === 'slow' ? 512 : 64 * 1024, 0x6e), timer = setInterval(() => { scheduledBytes += chunk.length; response.write(chunk); if (mode === 'overflow' && scheduledBytes >= 32 * 1024 * 1024) response.end() }, mode === 'slow' ? 25 : 2); chunks.add(timer)
        response.on('close', () => { clearInterval(timer); chunks.delete(timer); chunk.fill(0) })
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`
      runtime = await BrowserProfileRuntime.create({ chromium, executable: report.executable, authority, downloads: manager, transferQualificationFactory: createChromiumRtcActivity, onOwnedProcess: stop => { nativeStop = stop },
        preflightExtras: empty, captureExtras: () => ({ bundle: empty(), assertCurrent: original, release() {} }), commitExtras: () => ({ committed: true }), selectedPage: () => engine?.selectedPage() ?? null,
        closeAndDrain: async () => ({ admissionClosed: true, drained: true }), checkpoint: async () => { throw Error('no checkpoint requested in native download probe') }, authorizeActivation: async () => ({ authority, assertCurrent: original }) })
      assert.equal(Object.isFrozen(nativeStop), true); assert.equal(runtime.context.pages().length, 1); assert.equal(runtime.network, 'blocked'); await runtime.activate('synthetic-fixture-grant'); admission = true
      const page = await runtime.newPage(origin + '/'); engine = await createManagedProfileEngine({ runtime, directory: path.join(directory, 'engine'), onDownload: download => { engineEvents++; runtime.downloadBinding.onDownload(download) } })
      const parent = await processState(runtime.processIdentity.pid); assert.equal(parent.started, runtime.processIdentity.started); assert.equal(parent.group, parent.pid); members = await groupMembers(parent.pid); roots.push({ pid: parent.pid, started: parent.started })
      const args = (await fs.readFile(`/proc/${parent.pid}/cmdline`, 'utf8')).split('\0'); assert.equal(args.includes('--no-sandbox'), false); assert.equal(args.includes('--remote-debugging-pipe'), true); assert.equal(args.some(value => value.startsWith('--remote-debugging-port=')), false)
      const downloadEvent = page.waitForEvent('download', { timeout: 5000 }); await page.click('#download'); const download = await downloadEvent
      if (mode !== 'normal') { assert.ok(manager.activity().pendingPhysicalOperations > 0); await assert.rejects(runtime.preflightResumeTabs(), /in_flight/) }
      await assert.doesNotReject(manager.whenDrained()); assert.equal(engineEvents, 1); assert.equal(manager.activity().cleanupUnknown, false)
      const ready = manager.completed(); assert.equal(ready.length, mode === 'normal' ? 1 : 0); let contentHash = null, borrowed
      if (mode === 'normal') {
        assert.equal(await download.failure(), null); assert.equal(ready[0].fileName, 'normal.txt'); assert.equal(Object.hasOwn(ready[0], 'path'), false)
        const area = await createAgentProfileFileArea({ directory: path.join(directory, 'artifacts'), assertCurrent: original }); staging = new ProfileFileStaging({ directory: area.directory, scope: 'a'.repeat(64), assertPrivateDirectory: area.assertPrivateDirectory }); artifacts = new AgentProfileArtifacts({ area, staging, authority })
        await artifacts.captureDownload({ receipt: ready[0].receipt, assertCurrent: original }); const [token] = artifacts.downloads({ assertCurrent: original }); assert.equal(token.bytes, body.length)
        await artifacts.consume(token.artifactToken, { assertCurrent: original, use: async bytes => { assert.deepEqual(bytes, body); contentHash = createHash('sha256').update(bytes).digest('hex'); borrowed = bytes } }); assert.ok(borrowed.every(byte => byte === 0)); assert.equal(artifacts.activity().pendingPhysicalOperations, 0)
      } else { assert.equal(typeof await download.failure(), 'string'); await until(() => streamClosed, 'actual browser cancellation must close the unfinished HTTP response') }
      assert.deepEqual(await fs.readdir(manager.directory), []); assert.equal(manager.activity().retainedDownloads, 0)
      const cleanup = await Promise.allSettled([Promise.resolve().then(() => runtime.dispose()), Promise.resolve().then(() => manager.dispose()), Promise.resolve().then(() => artifacts?.dispose()), Promise.resolve().then(() => staging?.dispose()), Promise.resolve().then(() => engine.stop())]); assert.ok(cleanup.every(value => value.status === 'fulfilled'), JSON.stringify(cleanup.map(value => value.status === 'rejected' ? String(value.reason) : 'fulfilled')))
      await manager.whenDrained(); await until(async () => { for (const member of members) { const actual = await processState(member.pid); if (actual?.started === member.started) return false } return (await groupMembers(parent.pid)).length === 0 }, 'every original and later owned browser group member must exit'); ownedBrowserGone = true
      await assert.rejects(fs.lstat(manager.directory), { code: 'ENOENT' }); assert.equal(manager.activity().cleanupUnknown, false)
      cleaned = true
      report.cases.push({ mode, browserVersion: runtime.browserVersion, actualUid: 1000, quarantineMode: '0700', defaultSandbox: true, privatePipe: true, explicitPrivateDownloadPath: true, earlyContextAndEngineHandlers: true, engineDownloadEvents: engineEvents, accepted: ready.length, scheduledServerBytes: scheduledBytes, contentHash, deadlineMs: mode === 'slow' ? 150 : 10000, observationMs: 5, boundedProbeConfiguration: true, originalBrowserGroupMembers: members.length, allOriginalAndLaterGroupMembersGone: true, ownedBrowserGone, rawDirectoryAbsent: true, physicalOperations: manager.activity().pendingPhysicalOperations, cleanupUnknown: false })
    } finally {
      admission = false; for (const timer of chunks) clearInterval(timer); if (!cleaned) await Promise.allSettled([Promise.resolve().then(() => runtime?.dispose()), Promise.resolve().then(() => manager?.dispose()), Promise.resolve().then(() => artifacts?.dispose()), Promise.resolve().then(() => staging?.dispose()), Promise.resolve().then(() => engine?.stop())]); current = false
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
      if (runtime && !ownedBrowserGone) { const actual = await processState(runtime.processIdentity.pid); if (actual?.started === runtime.processIdentity.started) await runtime.emergencyStopOwnedProcess() }
    }
  }
  assert.equal(report.cases.length, 3); report.cleanup = { originallyOwnedBrowserRoots: roots.length, allGone: (await Promise.all(roots.map(async row => (await processState(row.pid))?.started !== row.started))).every(Boolean), allGroupsEmpty: (await Promise.all(roots.map(async row => (await groupMembers(row.pid)).length === 0))).every(Boolean), literalLoopbackFixture: true, externalNetworkIsolationIsRunnerRequirement: true }
  assert.equal(report.cleanup.allGone, true); assert.equal(report.cleanup.allGroupsEmpty, true)
} catch (error) { failed = error; report.error = String(error?.stack || error) }
finally {
  assert.equal(path.dirname(base), '/proof'); assert.match(path.basename(base), /^download-native-[A-Za-z0-9]+$/); await fs.rm(base, { recursive: true, force: false })
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
}
if (failed) throw failed
