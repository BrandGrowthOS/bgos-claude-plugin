import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildReachableChatsPath,
  summarizeReachableChats,
} from '../lib/reachable-chats.ts'

test('list_chats hits GET peers/reachable (no /api/v1 prefix, resolved by API_BASE)', () => {
  assert.equal(buildReachableChatsPath(), 'peers/reachable')
})

test('summary counts closed bridged bindings and how many are revivable', () => {
  const payload = {
    chats: [
      { kind: 'main' },
      { kind: 'a2a', binding: { status: 'open', revivable: false } },
      { kind: 'a2a', binding: { status: 'closed', revivable: true } },
      { kind: 'a2a', binding: { status: 'closed', revivable: false } }, // revoked
      { kind: 'a2a', binding: null }, // orphan
    ],
  }
  assert.equal(
    summarizeReachableChats(payload),
    '5 reachable chat(s); 2 closed bridged (1 revivable by replying).',
  )
})

test('summary is safe on empty / malformed payloads', () => {
  assert.equal(
    summarizeReachableChats({ chats: [] }),
    '0 reachable chat(s); 0 closed bridged (0 revivable by replying).',
  )
  assert.equal(
    summarizeReachableChats({}),
    '0 reachable chat(s); 0 closed bridged (0 revivable by replying).',
  )
  assert.equal(
    summarizeReachableChats(null),
    '0 reachable chat(s); 0 closed bridged (0 revivable by replying).',
  )
})
