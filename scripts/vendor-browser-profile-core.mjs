#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const value = name => { const i = process.argv.indexOf(name); if (i < 0 || !process.argv[i + 1]) throw new Error(`Required ${name}`); return process.argv[i + 1] }
const source = resolve(value('--source')), ref = value('--ref'), write = process.argv.includes('--write')
const git = args => { const result = spawnSync('git', ['-C', source, ...args], { maxBuffer: 32 * 1024 * 1024, windowsHide: true }); if (result.status !== 0) throw new Error('Committed BGOS source is unavailable'); return result.stdout }
const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]).toString().trim()
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid source commit')
const destination = join(root, 'lib/browser-profile-core'), files = {}
for (const name of ['crypto.js', 'storage.js', 'portable-state.js', 'resume-tabs.js', 'runtime-readiness.js', 'native-runtime.js', 'coordinator-client.js', 'runtime-endpoint.js', 'stopped-head-stage.js', 'checkpoint-store.js', 'runtime-status-client.js', 'return-intent.js', 'profile-file-crypto.js', 'profile-file-wire.js', 'profile-file-client.js', 'profile-file-staging.js', 'active-backup-client.js', 'active-backup-scheduler.js', 'active-backup-wire.js', 'active-backup-crypto.js', 'live-backup-input.js', 'live-backup-capture.js', 'live-storage-reader.js', 'backup-seal-client.js', 'backup-seal-worker.js', 'backup-journal.js', 'backup-journal-worker.js']) {
  const sourcePath = `frontend/electron-app/agent-browser/profile-sync/${name}`, bytes = git(['show', `${commit}:${sourcePath}`])
  if (bytes.includes(13)) throw new Error(`${name} must be LF in the committed source`)
  files[name] = { source: `BGOS: ${sourcePath}`, sha256: createHash('sha256').update(bytes).digest('hex') }
  if (write) { mkdirSync(destination, { recursive: true }); writeFileSync(join(destination, name), bytes) }
  else if (!readFileSync(join(destination, name)).equals(bytes)) throw new Error(`${name} differs from committed source`)
}
const manifest = { version: 1, sourceCommit: commit, why: 'Byte-identical encrypted checkpoint, lossless storage, portable state and resume readiness, cookie codecs, typed runtime endpoint, signed stopped-head lineage, separate permissioned file crypto/client/private materialization and encrypted local journal shared with HOAI. Explicit fixed-principal active backup transport, scheduler, readonly capture and seal/journal workers are included as pure main-only dependencies; they provide no activation authority. NativeRuntime exports are pure until its injected Electron constructor runs. The pairing adapter shares pure endpoint and document validation and never instantiates or inherits the desktop Bearer client. ProfileFileClient fixes its principal explicitly; paired use obtains only fresh pairing proof. Electron OS folder policy and native dialogs are intentionally excluded.', files }
if (write) {
  writeFileSync(join(destination, 'package.json'), '{"private":true,"type":"commonjs"}\n')
  writeFileSync(join(destination, 'vendor.json'), JSON.stringify(manifest, null, 2) + '\n')
} else if (JSON.stringify(JSON.parse(readFileSync(join(destination, 'vendor.json'), 'utf8'))) !== JSON.stringify(manifest)) throw new Error('Vendor manifest differs from committed source')
console.log(JSON.stringify({ mode: write ? 'copied-committed-source' : 'verified', ...manifest }))
