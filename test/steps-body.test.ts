/**
 * The Steps snapshot rebuilt from disk.
 *
 * Claude Code writes one file per task at ~/.claude/tasks/<session_id>/<n>.json.
 * Verified shape on this machine:
 *   { "id": "1", "subject": "Say hello", "description": "Say hello",
 *     "status": "completed", "blocks": [], "blockedBy": [] }
 * with an optional "activeForm" on sessions that supplied one.
 *
 * A daemon that attaches part way through a session never saw the TaskCreate
 * hooks, so SessionStart rebuilds the list from these files instead. The
 * ordering trap: the file names are "1", "2", "10", and a lexical sort puts
 * "10" between "1" and "2", which silently reorders the owner's plan.
 *
 * blocks / blockedBy map naturally onto waitsFor later; this release sends no
 * waitsFor, exactly like the Codex lane.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  STEPS_MAX_ROWS,
  STEPS_MAX_TEXT,
  stepsFromTaskFiles,
  taskDirFor,
} from '../lib/hook-events.ts'

const file = (name: string, json: unknown) => ({ name, json })

test('task files sort numerically, not lexically', () => {
  const steps = stepsFromTaskFiles([
    file('10.json', { id: '10', subject: 'ten', status: 'pending' }),
    file('2.json', { id: '2', subject: 'two', status: 'pending' }),
    file('1.json', { id: '1', subject: 'one', status: 'pending' }),
  ])
  assert.deepEqual(steps.map((s) => s.text), ['one', 'two', 'ten'])
})

test('statuses map to the Steps vocabulary', () => {
  const steps = stepsFromTaskFiles([
    file('1.json', { id: '1', subject: 'done one', status: 'completed' }),
    file('2.json', { id: '2', subject: 'running one', status: 'in_progress' }),
    file('3.json', { id: '3', subject: 'waiting one', status: 'pending' }),
    file('4.json', { id: '4', subject: 'unknown one', status: 'something_new' }),
  ])
  assert.deepEqual(steps.map((s) => s.status), ['done', 'running', 'pending', 'pending'])
  assert.equal('waitsFor' in steps[0]!, false, 'this release sends no waitsFor')
})

test('activeForm is the live wording, the subject is the fallback', () => {
  const steps = stepsFromTaskFiles([
    file('1.json', { id: '1', subject: 'Ship the card', activeForm: 'Shipping the card', status: 'in_progress' }),
    file('2.json', { id: '2', subject: 'Write the tests', status: 'pending' }),
  ])
  assert.deepEqual(steps.map((s) => s.text), ['Shipping the card', 'Write the tests'])
})

test('a deleted or textless task is not a step', () => {
  const steps = stepsFromTaskFiles([
    file('1.json', { id: '1', subject: 'kept', status: 'pending' }),
    file('2.json', { id: '2', subject: 'gone', status: 'deleted' }),
    file('3.json', { id: '3', subject: '   ', status: 'pending' }),
    file('4.json', 'not an object'),
  ])
  assert.deepEqual(steps.map((s) => s.text), ['kept'])
})

test('the list is clipped to 30 rows and each row to 200 characters', () => {
  const many = Array.from({ length: 50 }, (_v, i) =>
    file(`${i + 1}.json`, { id: String(i + 1), subject: 'y'.repeat(400), status: 'pending' }),
  )
  const steps = stepsFromTaskFiles(many)
  assert.equal(steps.length, STEPS_MAX_ROWS)
  assert.equal(steps[0]!.text.length, STEPS_MAX_TEXT)
})

test('an empty or unreadable task directory is an empty list, never a throw', () => {
  assert.deepEqual(stepsFromTaskFiles([]), [])
  assert.deepEqual(stepsFromTaskFiles([file('junk', null)]), [])
})

test('a secret in a task subject is masked like any other wire string', () => {
  const steps = stepsFromTaskFiles([
    file('1.json', { id: '1', subject: 'rotate AKIAIOSFODNN7EXAMPLE now', status: 'pending' }),
  ])
  assert.ok(!steps[0]!.text.includes('AKIAIOSFODNN7EXAMPLE'))
  assert.match(steps[0]!.text, /\[redacted:aws_access_key_id\]/)
})

test('taskDirFor names the directory the CLI actually writes', () => {
  assert.equal(taskDirFor('/home/karim/.claude', 'abc-123'), '/home/karim/.claude/tasks/abc-123')
  assert.equal(taskDirFor('C:\\Users\\kc\\.claude\\', 'abc'), 'C:\\Users\\kc\\.claude/tasks/abc')
})
