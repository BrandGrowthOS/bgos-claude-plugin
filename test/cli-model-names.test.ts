/**
 * The model names the installed Claude Code knows (lib/cli-model-names.ts),
 * read from its own file. The CLI has no command that lists them, and it
 * flags a name outside its own table as unrecognized even when the API
 * serves it, so a server catalog id is offered only when this table names
 * it.
 *
 * Every file here is a fake: nothing is read from disk.
 *
 * Run: npx tsx --test test/cli-model-names.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CliModelNames, collectModelNames } from '../lib/cli-model-names.ts'

const bytes = (text: string) => Buffer.from(text, 'latin1')

test('the quoted model names in the CLI file are found across chunk boundaries, and nothing else is', async () => {
  const names = await collectModelNames([
    bytes('x\u0000"claude-opus-4-8",y "claude-son'),
    bytes('net-4-6" claude-haiku-9 "claude-x&y" "opus" "claude-sonnet" "claude-'),
    bytes(`${'a'.repeat(200)}" 'claude-fable-9' "claude-opus-5-5"`),
  ])
  assert.deepEqual([...names].sort(), ['claude-opus-4-8', 'claude-opus-5-5', 'claude-sonnet-4-6'])
})

test('a name with no version number in it is no model name', async () => {
  const names = await collectModelNames([bytes('"claude-sonnet" "claude-code" "claude-opus-6" "claude-3-5-sonnet"')])
  assert.deepEqual([...names].sort(), ['claude-3-5-sonnet', 'claude-opus-6'])
})

test('a name split right after its opening quote is still found', async () => {
  const names = await collectModelNames([bytes('aaaa"'), bytes('claude-opus-4-7"'), bytes('"cl'), bytes('aude-haiku-5-5"')])
  assert.deepEqual([...names].sort(), ['claude-haiku-5-5', 'claude-opus-4-7'])
})

function rig() {
  const files = new Map<string, { size: number; mtimeMs: number; text: string }>()
  const state = { exe: '/home/u/.local/bin/claude' as string | null, reads: 0, fail: false }
  const names = new CliModelNames({
    exe: () => state.exe,
    stat: (path) => {
      const f = files.get(path)
      return f ? { size: f.size, mtimeMs: f.mtimeMs } : null
    },
    read: (path) => {
      state.reads++
      if (state.fail) throw new Error('EACCES')
      return [bytes(files.get(path)?.text ?? '')]
    },
  })
  return { files, state, names }
}

test('names are read once per CLI file, again when the file changes, and never without a CLI', async () => {
  const r = rig()
  r.files.set('/home/u/.local/bin/claude', { size: 10, mtimeMs: 1, text: '"claude-opus-6"' })
  assert.equal(r.names.now(), null, 'not read yet: unknown, so nothing is offered')
  assert.deepEqual([...((await r.names.ready()) ?? [])], ['claude-opus-6'])
  assert.deepEqual([...(r.names.now() ?? [])], ['claude-opus-6'])
  await r.names.ready()
  assert.equal(r.state.reads, 1, 'read once')

  r.files.set('/home/u/.local/bin/claude', { size: 11, mtimeMs: 2, text: '"claude-opus-7"' })
  assert.equal(r.names.now(), null, 'a changed file is not the file that was read')
  assert.deepEqual([...((await r.names.ready()) ?? [])], ['claude-opus-7'])
  assert.equal(r.state.reads, 2)

  r.state.exe = null
  assert.equal(r.names.now(), null)
  assert.equal(await r.names.ready(), null)
  assert.equal(r.state.reads, 2)
})

test('a CLI file that cannot be read leaves the names unknown, and is not read again until it changes', async () => {
  const r = rig()
  r.files.set('/home/u/.local/bin/claude', { size: 10, mtimeMs: 1, text: '"claude-opus-6"' })
  r.state.fail = true
  assert.equal(await r.names.ready(), null)
  assert.equal(await r.names.ready(), null)
  assert.equal(r.state.reads, 1)
  r.state.fail = false
  r.files.set('/home/u/.local/bin/claude', { size: 10, mtimeMs: 3, text: '"claude-opus-6"' })
  assert.deepEqual([...((await r.names.ready()) ?? [])], ['claude-opus-6'])
})
