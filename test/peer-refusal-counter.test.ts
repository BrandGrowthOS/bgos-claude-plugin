/**
 * lib/peer-refusal-counter.mjs: the demand meter for the peer-delegation question
 * (docs/proposals/peer-delegation-private-tools.md, KC 2026-10-12: wait and see the impact).
 *
 * Run: npx tsx --test test/peer-refusal-counter.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { PEER_REFUSAL_FILE_NAME, PEER_REFUSAL_KEEP_DAYS, dayKey, readPeerRefusals, recordPeerRefusal } from '../lib/peer-refusal-counter.mjs'

const T0 = Date.UTC(2026, 9, 12, 8, 0, 0)
const DAY = 24 * 60 * 60 * 1000
const dir = () => mkdtempSync(join(tmpdir(), 'peer-refusal-'))

test('one refusal is one line with the tool, the delegate, the target and a running count, and nothing else', () => {
  const d = dir()
  const first = recordPeerRefusal({ dir: d, tool: 'boards_query', delegate: 888, target: 1050, now: T0 })
  assert.equal(first.line, 'peer private call refused: tool=boards_query delegate=888 target=1050 today=1')
  const second = recordPeerRefusal({ dir: d, tool: 'boards_query', delegate: 888, target: 1050, now: T0 + 1000 })
  assert.match(second.line, /today=2$/)
})

test('the daily file aggregates per delegate and tool and a reader sums them', () => {
  const d = dir()
  recordPeerRefusal({ dir: d, tool: 'boards_query', delegate: 888, target: 1050, now: T0 })
  recordPeerRefusal({ dir: d, tool: 'boards_query', delegate: 888, target: 1050, now: T0 })
  recordPeerRefusal({ dir: d, tool: 'schedule', delegate: 888, target: 1050, now: T0 })
  recordPeerRefusal({ dir: d, tool: 'boards_update', delegate: 910, target: 1050, now: T0 })
  assert.deepEqual(readPeerRefusals(d, dayKey(T0)), {
    day: '2026-10-12',
    total: 4,
    byTool: { boards_query: 2, schedule: 1, boards_update: 1 },
    byDelegate: { '888': 3, '910': 1 },
  })
})

test('a new day starts a new count, and days past the keep window are dropped', () => {
  const d = dir()
  recordPeerRefusal({ dir: d, tool: 'schedule', delegate: 888, target: 1050, now: T0 })
  const next = recordPeerRefusal({ dir: d, tool: 'schedule', delegate: 888, target: 1050, now: T0 + DAY })
  assert.match(next.line, /today=1$/)
  for (let i = 2; i < PEER_REFUSAL_KEEP_DAYS + 5; i++) recordPeerRefusal({ dir: d, tool: 'schedule', delegate: 888, target: 1050, now: T0 + i * DAY })
  const doc = JSON.parse(readFileSync(join(d, PEER_REFUSAL_FILE_NAME), 'utf8'))
  assert.equal(Object.keys(doc.days).length, PEER_REFUSAL_KEEP_DAYS)
  assert.equal(doc.days['2026-10-12'], undefined, 'the oldest day is gone')
})

test('only ids and the tool name can reach the file: free text is stripped', () => {
  const d = dir()
  const out = recordPeerRefusal({ dir: d, tool: 'boards_query\nsecret board name', delegate: 'agent 888 "Mark"', target: 1050, now: T0 })
  assert.equal(out.line, 'peer private call refused: tool=invalid delegate=invalid target=1050 today=1')
  assert.doesNotMatch(out.line, /secret|Mark|\n/)
  assert.doesNotMatch(readFileSync(join(d, PEER_REFUSAL_FILE_NAME), 'utf8'), /secret|Mark/)
})

test('a junk file is started again and a write that fails never throws or changes the line', () => {
  const d = dir()
  writeFileSync(join(d, PEER_REFUSAL_FILE_NAME), '{ not json')
  assert.match(recordPeerRefusal({ dir: d, tool: 'schedule', delegate: 888, target: 1050, now: T0 }).line, /today=1$/)
  const broken = {
    readFileSync: () => { throw new Error('EIO') },
    writeFileSync: () => { throw new Error('EROFS') },
    renameSync: () => { throw new Error('EROFS') },
    mkdirSync: () => { throw new Error('EROFS') },
  }
  const out = recordPeerRefusal({ dir: d, tool: 'schedule', delegate: 888, target: 1050, now: T0, fs: broken })
  assert.match(out.line, /tool=schedule delegate=888 target=1050/)
})
