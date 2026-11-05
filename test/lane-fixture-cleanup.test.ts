import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processStamp } from '../lib/lane-process.ts'

test('lane cleanup ends a detached writer before removing its fixture home', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const { cleanupLaneFixture } = await import('./helpers/lane-fixture-cleanup.ts')
  const dir = mkdtempSync(join(tmpdir(), 'lane-cleanup-'))
  const ready = join(dir, 'ready')
  const writer = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{fs.mkdirSync(${JSON.stringify(join(dir, 'live'))},{recursive:true});fs.writeFileSync(${JSON.stringify(join(dir, 'live', 'writing'))},'made-up')},2)`
  const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(writer)}],{detached:true,stdio:'ignore'});setInterval(()=>{},1000)`
  const child = spawn(process.execPath, ['-e', parent], { detached: true, stdio: 'ignore' })
  const closed = new Promise<void>((done) => child.on('close', () => done()))
  let writerPid = 0
  try {
    const deadline = Date.now() + 5_000
    while (!existsSync(ready) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10))
    assert.ok(existsSync(ready))
    writerPid = Number(readFileSync(ready, 'utf8'))
    await cleanupLaneFixture(dir, child.pid!)
    assert.equal(await processStamp(writerPid), null)
    await closed
    assert.equal(existsSync(dir), false)
    await new Promise((done) => setTimeout(done, 50))
    assert.equal(existsSync(dir), false, 'the writer cannot recreate it')
  } finally {
    if (writerPid) try { process.kill(writerPid, 'SIGKILL') } catch {}
    child.kill('SIGKILL')
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
