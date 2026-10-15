import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { AgentProfileDownloads } from '../../lib/browser-profile-downloads.mjs'
import { AgentProfileArtifacts } from '../../lib/browser-profile-artifacts.mjs'
const require = createRequire(import.meta.url), codec = require('../../lib/browser-profile-core/crypto.js'), { ProfileFileStaging } = require('../../lib/browser-profile-core/profile-file-staging.js')
/** @returns {{promise: Promise<any>, resolve: (value?: any) => void, reject: (error?: any) => void}} */
export const deferred = () => { let resolve = /** @type {(value?: any) => void} */ (() => {}), reject = /** @type {(error?: any) => void} */ (() => {}); const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
export async function downloadFixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hoai-download-unit-')), endpoint = codec.createEndpointIdentity(randomUUID())
  const authority = options.authority || { profileId: randomUUID(), actingUserId: 'recipient', assistantId: 42, endpointId: endpoint.identity.endpointId, keyFingerprint: codec.identityFingerprint(endpoint.identity), grantVersion: 1, bootId: randomUUID(), runtimeId: randomUUID(), sessionId: randomUUID(), writerEpoch: 1, revision: 1, contentKeyEpoch: 1 }
  const state = /** @type {any} */ ({ current: true, active: true, stopCalls: 0, cancelCalls: 0, deleteCalls: 0, beforeLstat: null, beforeChmod: null, beforeDelete: null, beforeCancel: null, beforeRead: null, stop: null }), downloads = [], pages = [], context = new EventEmitter(); context.pages = () => pages
  // The real temporary files/inodes are used. This unit-only injected area and
  // UID/mode projection are synthetic; the Linux probe must prove real privacy.
  const wrap = stat => new Proxy(stat, { get(target, key) { if (key === 'uid') return 1000; if (key === 'mode') return target.isDirectory() ? 0o40700 : 0o100600; const value = target[key]; return typeof value === 'function' ? value.bind(target) : value } })
  const filesystem = { ...fs, lstat: async file => { await state.beforeLstat?.(file); return wrap(await fs.lstat(file)) }, chmod: async (file, mode) => { await state.beforeChmod?.(file); return fs.chmod(file, mode) }, open: async (...args) => { const handle = await fs.open(...args); return { read: async (...input) => { await state.beforeRead?.(); return handle.read(...input) }, write: (...input) => handle.write(...input), stat: async () => wrap(await handle.stat()), close: () => handle.close() } } }
  const current = () => { assert.equal(state.current, true, 'original fixture context changed'); return true }
  const manager = await AgentProfileDownloads.create({ directory: path.join(root, 'quarantine'), authority, assertCurrent: current, isActive: () => state.active,
    createArea: async ({ directory, assertCurrent }) => { assertCurrent(); await fs.mkdir(directory, { recursive: true, mode: 0o700 }); return { directory, assertPrivateDirectory: async target => { assert.ok(target === directory || target.startsWith(directory + path.sep)); assert.equal((await fs.lstat(target)).isSymbolicLink(), false); return true } } }, filesystem, uid: 1000, ...options })
  const launch = options.unbound ? { downloadsPath: manager.directory } : await manager.launchOptions()
  // One fake native file owner serializes its own stop/cancel/delete removals.
  // Concurrent Windows unlink calls can otherwise produce EPERM, unlike the
  // single Chromium download owner being modeled; errors still propagate.
  const nativeRemovals = new Map()
  const nativeRemove = file => { const task = (nativeRemovals.get(file) || Promise.resolve()).then(async () => { for (const item of [file, file + '.crdownload']) await fs.unlink(item).catch(error => { if (error.code !== 'ENOENT') throw error }) }); nativeRemovals.set(file, task); return task }
  if (!options.unbound) await manager.bind({ context, stopBrowser: async () => { state.stopCalls++; for (const item of downloads) { await nativeRemove(item.file); item.failure.resolve('browser stopped') }; return state.stop ? state.stop() : true } })
  const page = { context: () => context }; pages.push(page)
  async function download({ bytes = Buffer.from('synthetic completed download'), fileName = 'report.txt', file, selectedPage = page, autoFinish = false } = {}) {
    file ||= path.join(launch.downloadsPath, randomUUID()); if (bytes) await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
    const failure = deferred(), value = { _artifact: { _initializer: { absolutePath: file } }, page: () => selectedPage, suggestedFilename: () => fileName,
      failure: () => failure.promise, cancel: async () => { state.cancelCalls++; await state.beforeCancel?.(); await nativeRemove(file); failure.resolve('cancelled') },
      delete: async () => { state.deleteCalls++; await state.beforeDelete?.(); await nativeRemove(file) } }
    const row = { value, failure, file }; downloads.push(row); if (autoFinish) failure.resolve(null); return row
  }
  async function cleanup() { for (const row of downloads) row.failure.resolve('fixture cleanup'); await manager.dispose().catch(() => {}); await fs.rm(root, { recursive: true, force: true }) }
  return { root, manager, authority, state, context, page, pages, launch, download, cleanup, filesystem }
}
export async function downloadArtifacts(fixture) {
  const directory = path.join(fixture.root, 'generated-artifacts'); await fs.mkdir(directory, { mode: 0o700 })
  const area = { directory, assertPrivateDirectory: async target => { assert.ok(target === directory || target.startsWith(directory + path.sep)); assert.equal((await fs.lstat(target)).isSymbolicLink(), false); return true } }
  const staging = new ProfileFileStaging({ directory, scope: 'a'.repeat(64), assertPrivateDirectory: area.assertPrivateDirectory })
  const artifacts = new AgentProfileArtifacts({ area, staging, authority: fixture.authority })
  return { artifacts, staging, async cleanup() { await artifacts.dispose().catch(() => {}); await staging.dispose().catch(() => {}) } }
}
