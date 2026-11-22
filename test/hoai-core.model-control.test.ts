/**
 * The Helper turns owner model control on for the agent it launches:
 * main() hands lib/model-control-store.mjs
 * ensureHelperModelControl this agent's id and folder before claude is
 * spawned, and nothing it does can stop the launch. A test that fakes the
 * spawn never reaches the real one.
 *
 * Run: npx tsx --test test/hoai-core.model-control.test.ts
 */

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { main } from '../bin/hoai-core.mjs'
import { scratchDir } from './helpers/scratch-dirs'

const SCRIPT_DIR = '/home/u/bgos-claude-plugin/bin'

function childExiting(code: number) {
  const child = new EventEmitter() as EventEmitter & { kill: () => void }
  child.kill = () => child.emit('exit', null, 'SIGTERM')
  setImmediate(() => child.emit('exit', code, null))
  return child
}

async function launch(ensure?: (input: Record<string, unknown>) => { on: boolean; reason: string }) {
  const home = scratchDir('hoai-mc-home-')
  const cwd = scratchDir('hoai-mc-agent-')
  mkdirSync(join(home, '.bgos-agent'), { recursive: true })
  writeFileSync(join(home, '.bgos-agent', 'credentials-42.json'), '{}')
  const order: string[] = []
  const prints: string[] = []
  const code = await main([], {
    platform: 'linux',
    env: { HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: '42' },
    home,
    cwd,
    scriptDir: SCRIPT_DIR,
    listProcesses: () => [],
    print: (line: string) => prints.push(line),
    healthyMs: 60_000,
    hasExpect: true,
    preseedTrust: () => {},
    // The activity hooks go into the same settings file: kept out, so the last test reads only this step.
    registerHooks: () => {},
    ...(ensure
      ? {
          ensureModelControl: (input: Record<string, unknown>) => {
            order.push('ensure')
            return ensure(input)
          },
        }
      : {}),
    spawnImpl: (() => {
      order.push('spawn')
      return childExiting(0)
    }) as never,
  } as never)
  return { code, order, prints, home, cwd }
}

test('main() turns model control on for this agent, in its own folder, before claude starts', async () => {
  const inputs: Array<Record<string, unknown>> = []
  const r = await launch((input) => {
    inputs.push(input)
    return { on: true, reason: 'on' }
  })
  assert.equal(r.code, 0, r.prints.join('\n'))
  assert.deepEqual(r.order, ['ensure', 'spawn'])
  assert.equal(inputs.length, 1)
  const input = inputs[0]!
  assert.equal(input.assistantId, '42', 'the service agent, by its id')
  assert.equal(input.cwd, r.cwd, 'the folder this launch runs in')
  assert.equal(input.platform, 'linux')
  assert.equal(input.dir, join(r.home, '.bgos-plugin-state', 'model-control'))
  assert.equal(input.configDir, resolve(r.cwd, join(r.home, '.claude')))
  assert.equal(String(input.pluginRoot).replace(/\\/g, '/'), '/home/u/bgos-claude-plugin')
  assert.equal(input.nodePath, process.execPath)
  assert.equal(input.home, r.home, 'the home: the home folder is refused, and the paired agents are read there')
  assert.equal(typeof input.nowMs, 'number')
})

test('a model control step that throws never stops the launch', async () => {
  const r = await launch(() => {
    throw new Error('disk full')
  })
  assert.equal(r.code, 0, r.prints.join('\n'))
  assert.deepEqual(r.order, ['ensure', 'spawn'])
})

test('a faked spawn with no model control step injected writes nothing to the agent folder', async () => {
  const r = await launch()
  assert.equal(r.code, 0, r.prints.join('\n'))
  assert.deepEqual(r.order, ['spawn'])
  assert.equal(existsSync(join(r.cwd, '.claude', 'settings.local.json')), false)
  assert.equal(existsSync(join(r.home, '.bgos-plugin-state', 'model-control', 'opt-in.json')), false)
})
