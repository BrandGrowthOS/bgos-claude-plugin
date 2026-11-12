/**
 * The two readers an owner's full access thread and a thread's cleanup rest
 * on (0.88.0), on a real disk: the main session's permission mode as its
 * transcript names it (lib/thread-transcript.ts latestPermissionMode), and
 * the bytes a path holds (lib/thread-access.ts diskUsage), which the close
 * log line reports.
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { agentSettingsPath, diskUsage } from '../lib/thread-access.ts'
import { latestPermissionMode } from '../lib/thread-transcript.ts'

const MAIN = '435f1f18-2716-4c27-bfd8-e2c48f28b3ac'
const mode = (m: string) => JSON.stringify({ type: 'permission-mode', permissionMode: m, sessionId: MAIN })
const user = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })

function withDir(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-access-'))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('the main session\'s permission mode is its transcript\'s latest permission-mode row', withDir(async (dir) => {
  const path = join(dir, 't.jsonl')
  writeFileSync(path, [mode('default'), user('hello'), mode('acceptEdits'), user('more'), mode('bypassPermissions'), user('last')].join('\n') + '\n')
  assert.equal(await latestPermissionMode(path), 'bypassPermissions')
  writeFileSync(path, [mode('bypassPermissions'), user('hello'), mode('plan')].join('\n'))
  assert.equal(await latestPermissionMode(path), 'plan', 'the newest row, also with no newline at the end')
}))

test('a transcript with no such row, an empty one and a missing one say nothing', withDir(async (dir) => {
  const path = join(dir, 't.jsonl')
  writeFileSync(path, [user('hello'), user('the words permission-mode and "permissionMode":"bypassPermissions" in a message are not the row')].join('\n') + '\n')
  assert.equal(await latestPermissionMode(path), null, 'a message that only quotes the words is not a mode')
  writeFileSync(path, '')
  assert.equal(await latestPermissionMode(path), null)
  assert.equal(await latestPermissionMode(join(dir, 'missing.jsonl')), null)
  writeFileSync(path, `${JSON.stringify({ type: 'permission-mode', permissionMode: 7 })}\n{"type":"permission-mode","permissionMode":""}\nnot json permission-mode\n`)
  assert.equal(await latestPermissionMode(path), null, 'a row with no readable mode is skipped')
}))

test('the row is found at every chunk size, far from the end of a long transcript', withDir(async (dir) => {
  const path = join(dir, 't.jsonl')
  const filler = Array.from({ length: 400 }, (_, i) => user(`turn ${i} ${'x'.repeat(i % 97)}`))
  writeFileSync(path, [user('first'), mode('acceptEdits'), ...filler].join('\n') + '\n')
  for (const chunk of [1, 7, 64, 1000, 1 << 20]) assert.equal(await latestPermissionMode(path, chunk), 'acceptEdits', `chunk ${chunk}`)
  writeFileSync(path, [mode('default'), ...filler, mode('dontAsk'), ...filler].join('\n') + '\n')
  for (const chunk of [3, 129, 4096]) assert.equal(await latestPermissionMode(path, chunk), 'dontAsk', `chunk ${chunk}`)
}))

test('disk usage is the bytes of a file or of everything under a folder, links not followed, 0 when it is not there', withDir(async (dir) => {
  writeFileSync(join(dir, 'a.txt'), 'x'.repeat(1000))
  mkdirSync(join(dir, 'sub', 'deep'), { recursive: true })
  writeFileSync(join(dir, 'sub', 'b.bin'), 'y'.repeat(2500))
  writeFileSync(join(dir, 'sub', 'deep', 'c.bin'), 'z'.repeat(40))
  assert.equal(await diskUsage(join(dir, 'a.txt')), 1000)
  assert.equal(await diskUsage(join(dir, 'missing')), 0)
  const big = mkdtempSync(join(tmpdir(), 'thread-access-out-'))
  try {
    writeFileSync(join(big, 'huge.bin'), 'h'.repeat(50_000))
    if (process.platform !== 'win32') symlinkSync(big, join(dir, 'sub', 'link'))
    const files = (await diskUsage(join(dir, 'sub', 'b.bin'))) + (await diskUsage(join(dir, 'sub', 'deep', 'c.bin')))
    assert.equal(files, 2540)
    const whole = await diskUsage(join(dir, 'sub'))
    assert.ok(whole >= 2540, 'every file under it')
    assert.ok(whole < 50_000, 'never what a link points to')
  } finally {
    rmSync(big, { recursive: true, force: true })
  }
}))

test('one agent\'s settings live beside its other state', () => {
  assert.equal(agentSettingsPath(join('/home/u', '.bgos-agent', '7')), join('/home/u', '.bgos-agent', '7', 'settings.json'))
})
