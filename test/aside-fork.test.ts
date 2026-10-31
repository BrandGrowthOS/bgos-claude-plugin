/**
 * By the way on Claude Code (spec 8.4, plan "Plugin (PR 2)" task 3): a one
 * shot fork of the main session with no tools, its text streamed as ordered
 * deltas, its answer the result frame, and its own session file ALWAYS
 * deleted afterwards. Driven with a fake child; no real claude runs here.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { ASIDE_TIMEOUT_MS, AsideError, runAside, type AsideDeps } from '../lib/aside-fork.ts'
import { asideArgs, asidePrompt } from '../lib/thread-lane-args.ts'
import type { StreamJsonChild } from '../lib/stream-json-child.ts'
import { sessionTranscriptPath } from '../bin/hoai-core.mjs'

const MAIN = '435f1f18-2716-4c27-bfd8-e2c48f28b3ac'
const FORK = 'c79518f7-be7b-41cc-a832-7cbdf5c476a4'
const HOME = '/home/u'
const FOLDER = '/work/atlas'
const MCP = '/home/u/.bgos-agent/7/threads/empty-mcp.json'

class FakeChild implements StreamJsonChild {
  stdin = ''
  ended = false
  killed: string[] = []
  private out: Array<(c: string) => void> = []
  private exits: Array<(code: number | null, signal: string | null) => void> = []
  write(c: string) { this.stdin += c }
  end() { this.ended = true }
  kill(s: 'SIGTERM' | 'SIGKILL') { this.killed.push(s) }
  onStdout(cb: (c: string) => void) { this.out.push(cb) }
  onExit(cb: (code: number | null, signal: string | null) => void) { this.exits.push(cb) }
  frame(f: Record<string, unknown>) { for (const cb of this.out) cb(`${JSON.stringify(f)}\n`) }
  exit(code: number | null = 0) { for (const cb of this.exits) cb(code, null) }
}

const init = (id: string) => ({ type: 'system', subtype: 'init', session_id: id })
const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })

function rig(over: Partial<AsideDeps> = {}) {
  const spawned: Array<{ command: string; args: string[]; cwd: string; child: FakeChild }> = []
  const deltas: Array<[number, string]> = []
  const unlinked: string[] = []
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const deps: AsideDeps = {
    spawn: (command, args, opts) => {
      const child = new FakeChild()
      spawned.push({ command, args, cwd: opts.cwd, child })
      return child
    },
    claudeBin: () => '/bin/claude',
    mainSessionId: () => MAIN,
    mainFolder: FOLDER,
    home: HOME,
    configDir: '',
    emptyMcpConfigPath: () => MCP,
    unlink: (p) => { unlinked.push(p) },
    onDelta: (seq, text) => { deltas.push([seq, text]) },
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true },
    ...over,
  }
  return { deps, spawned, deltas, unlinked, timers }
}

const input = { question: 'What is the code word?', quote: 'Remember PELICAN-42.', history: [{ q: 'hi', a: 'hello' }] }
const forkFile = sessionTranscriptPath(HOME, FOLDER, FORK, '')
const mainFile = sessionTranscriptPath(HOME, FOLDER, MAIN, '')

test('with no proven main session it refuses with no_session and spawns nothing', async () => {
  const r = rig({ mainSessionId: () => null })
  await assert.rejects(runAside(input, r.deps), (err: unknown) => err instanceof AsideError && err.code === 'no_session')
  assert.equal(r.spawned.length, 0)
})

test('with no claude binary it refuses with unavailable and spawns nothing', async () => {
  const r = rig({ claudeBin: () => null })
  await assert.rejects(runAside(input, r.deps), (err: unknown) => err instanceof AsideError && err.code === 'unavailable')
  assert.equal(r.spawned.length, 0)
})

test('it forks the main session in the main folder with the aside command and the prompt on stdin', async () => {
  const r = rig()
  const answer = runAside(input, r.deps)
  const s = r.spawned[0]!
  assert.equal(s.command, '/bin/claude')
  assert.deepEqual(s.args, asideArgs({ mainSessionId: MAIN, emptyMcpConfigPath: MCP }))
  assert.equal(s.cwd, FOLDER)
  assert.equal(s.child.stdin, asidePrompt(input.question, input.quote, input.history))
  assert.equal(s.child.ended, true)
  s.child.frame(init(FORK))
  s.child.frame({ type: 'result', subtype: 'success', is_error: false, result: 'PELICAN-42' })
  s.child.exit(0)
  assert.deepEqual(await answer, { text: 'PELICAN-42' })
})

test('text deltas stream as ordered progress, numbered from 0', async () => {
  const r = rig()
  const answer = runAside(input, r.deps)
  const c = r.spawned[0]!.child
  c.frame(init(FORK))
  c.frame({ type: 'stream_event', event: { type: 'message_start' } })
  c.frame(delta('PELIC'))
  c.frame({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } })
  c.frame(delta('AN-42'))
  c.frame({ type: 'result', subtype: 'success', is_error: false, result: 'PELICAN-42' })
  c.exit(0)
  await answer
  assert.deepEqual(r.deltas, [[0, 'PELIC'], [1, 'AN-42']])
})

test('the fork session file is deleted after the answer, and the main file never is', async () => {
  const r = rig()
  const answer = runAside(input, r.deps)
  const c = r.spawned[0]!.child
  c.frame(init(FORK))
  c.frame({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
  c.exit(0)
  await answer
  assert.deepEqual(r.unlinked, [forkFile])
  assert.equal(r.unlinked.includes(mainFile), false)
})

test('an init frame that names the MAIN session is never treated as the fork', async () => {
  const r = rig()
  const answer = runAside(input, r.deps)
  const c = r.spawned[0]!.child
  c.frame(init(MAIN))
  c.frame({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
  c.exit(0)
  await answer
  assert.deepEqual(r.unlinked, [])
})

test('a missing result falls back to the streamed text', async () => {
  const r = rig()
  const answer = runAside(input, r.deps)
  const c = r.spawned[0]!.child
  c.frame(init(FORK))
  c.frame(delta('Half '))
  c.frame(delta('an answer'))
  c.exit(0)
  assert.deepEqual(await answer, { text: 'Half an answer' })
  assert.deepEqual(r.unlinked, [forkFile])
})

test('a fork that says nothing (it tried a tool, or failed) is failed, and still cleaned up', async () => {
  const r = rig()
  const answer = runAside(input, r.deps)
  const c = r.spawned[0]!.child
  c.frame(init(FORK))
  c.frame({ type: 'result', subtype: 'error_max_turns', is_error: true })
  c.exit(1)
  await assert.rejects(answer, (err: unknown) => err instanceof AsideError && err.code === 'failed')
  assert.deepEqual(r.unlinked, [forkFile])
})

test('the hard timeout is 55 s: it kills the child, answers timed_out, and deletes the fork file once it exits', async () => {
  const r = rig()
  const answer = runAside(input, r.deps)
  const c = r.spawned[0]!.child
  c.frame(init(FORK))
  c.frame(delta('thinking'))
  assert.equal(ASIDE_TIMEOUT_MS, 55_000)
  assert.equal(r.timers[0]!.ms, 55_000)
  r.timers[0]!.fn()
  await assert.rejects(answer, (err: unknown) => err instanceof AsideError && err.code === 'timed_out')
  assert.deepEqual(c.killed, ['SIGKILL'])
  assert.deepEqual(r.unlinked, [], 'not while the killed child may still write')
  c.exit(null)
  assert.deepEqual(r.unlinked, [forkFile])
})

test('a child that exits before any frame is failed', async () => {
  const r = rig()
  const answer = runAside(input, r.deps)
  r.spawned[0]!.child.exit(null)
  await assert.rejects(answer, (err: unknown) => err instanceof AsideError && err.code === 'failed')
  assert.equal(r.timers[0]!.cleared, true)
})
