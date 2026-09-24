/**
 * lib/floor-state.mjs: the attached marker the floor hook asks behind, and
 * the floor record the relay decides from.
 *
 * Two review findings are pinned here. The hook asked in every session on a
 * machine with the plugin enabled, so a personal `claude` got prompts and a
 * switch-off owner paid a round trip; it now asks only where a live HOAI
 * daemon marked the session's folder. And the relay decided from the CLI's
 * preview, which the CLI cuts in the middle when a value is long, so a listed
 * action in the middle of a long command was auto approved; the relay now
 * takes the hook's record, matched to the request by a probe that survives
 * the cut.
 *
 * Run with: npx tsx --test test/floor-state.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FLOOR_RECORD_MATCH_WINDOW_MS,
  FLOOR_RECORD_STALE_MS,
  buildFloorRecord,
  clearFloorAttached,
  findAttachedKey,
  floorAsksDir,
  floorKey,
  floorStateRoot,
  folderAndAncestors,
  markFloorAttached,
  normalizeFloorFolder,
  previewProbe,
  sessionFolders,
  takeFloorRecord,
  valueProbe,
  writeFloorRecord,
} from '../lib/floor-state.mjs'
import { classifyToolCall } from '../lib/hard-floor.ts'
import { stateRoot as forwarderStateRoot } from '../bin/hoai-hook.mjs'
import { hookStateRoot } from '../lib/hook-intake.ts'

/** Claude Code 2.1.281's preview (see test/floor-check.test.ts for the source). */
function cliElide(text: string): string {
  const points = Array.from(text)
  if (points.length <= 3500) return text
  const cut = points.length - 3500
  return `${points.slice(0, 2000).join('')}\n\u22EF ${cut} code points elided \u22EF\n${points.slice(points.length - 1500).join('')}`
}
const cliPreview = (input: Record<string, unknown>) =>
  `{ ${Object.entries(input)
    .map(([k, v]) => `${cliElide(JSON.stringify(k).replace(/\s{2,}/g, ' '))}: ${cliElide(JSON.stringify(v).replace(/\s{2,}/g, ' '))}`)
    .join(', ')} }`

const tempRoot = () => mkdtempSync(join(tmpdir(), 'hoai-floor-state-'))

test('one state root for the hook, the forwarder and the intake', () => {
  for (const env of [{}, { BGOS_PLUGIN_STATE_DIR: '/x/state' }]) {
    assert.equal(floorStateRoot(env, '/home/kc'), forwarderStateRoot(env, '/home/kc'))
    assert.equal(floorStateRoot(env, '/home/kc'), hookStateRoot(env, '/home/kc'))
  }
})

test('a folder has one key however the session and the daemon spell it', () => {
  const same = [
    '/mnt/e/agents/hoai-dev',
    'E:\\agents\\hoai-dev',
    'e:/agents/hoai-dev/',
    'E:/Agents/HOAI-dev',
    '\\\\?\\E:\\agents\\hoai-dev',
  ]
  const keys = new Set(same.map((f) => floorKey(f)))
  assert.equal(keys.size, 1, [...same.map((f) => normalizeFloorFolder(f))].join(' | '))
  assert.notEqual(floorKey('/mnt/e/agents/other'), floorKey('/mnt/e/agents/hoai-dev'))
  assert.equal(floorKey(''), '')
  assert.equal(floorKey(undefined), '')
  assert.match(floorKey('/w'), /^[0-9a-f]{32}$/)
})

test('the folders a session may be keyed by: the project dir, the cwd, and the folders above it', () => {
  assert.deepEqual(folderAndAncestors('/mnt/e/a/b'), ['/mnt/e/a/b', '/mnt/e/a', '/mnt/e', '/mnt', '/'])
  assert.deepEqual(folderAndAncestors('C:\\Users\\kc'), ['C:/Users/kc', 'C:/Users', 'C:/'])
  const folders = sessionFolders({ cwd: '/w/agent/src' }, { CLAUDE_PROJECT_DIR: '/w/agent' })
  assert.equal(folders[0], '/w/agent')
  assert.ok(folders.includes('/w/agent/src'))
  assert.equal(new Set(folders.map((f: string) => floorKey(f))).size, folders.length, 'no folder twice')
  assert.deepEqual(sessionFolders({}, {}), [])
})

test('attached: a live marker for the folder, and nothing else', () => {
  const root = tempRoot()
  try {
    const folder = '/mnt/e/agents/hoai-dev'
    assert.equal(findAttachedKey({ root, folders: [folder] }), null, 'no marker, not attached')
    const keys = markFloorAttached({ root, folders: [folder, 'E:\\agents\\hoai-dev'], pid: process.pid })
    assert.deepEqual(keys, [floorKey(folder)], 'one marker for one folder, however it is spelled')
    assert.equal(findAttachedKey({ root, folders: ['/elsewhere', folder] }), floorKey(folder))
    assert.equal(findAttachedKey({ root, folders: [folder], isAlive: () => false }), null, 'a dead pid is not attached')
    // Taken down only by the daemon that wrote it.
    clearFloorAttached({ root, keys, pid: process.pid + 1 })
    assert.equal(findAttachedKey({ root, folders: [folder] }), floorKey(folder))
    clearFloorAttached({ root, keys, pid: process.pid })
    assert.equal(findAttachedKey({ root, folders: [folder] }), null)
    // A marker that is junk reads as not attached, never as a throw.
    mkdirSync(join(root, 'floor', 'attached'), { recursive: true })
    writeFileSync(join(root, 'floor', 'attached', `${floorKey(folder)}.json`), '{{')
    assert.equal(findAttachedKey({ root, folders: [folder] }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const LONG = `echo ${'a'.repeat(2500)} ; rm -rf ~/work ; echo ${'b'.repeat(2000)}`

test('the probe survives the CLI cut, its whitespace folding and its JSON rendering', () => {
  const input = { command: LONG, description: 'Clean up' }
  const preview = cliPreview(input)
  assert.ok(preview.includes('code points elided'))
  assert.deepEqual(previewProbe('command', preview), valueProbe(LONG))
  // Whitespace runs the CLI folds are not letters, so the probe does not move.
  const spaced = `rm  -rf    build\t\tnow`
  assert.deepEqual(previewProbe('command', cliPreview({ command: spaced })), valueProbe(spaced))
  assert.equal(previewProbe('command', '{ "file_path": "/x" }'), null)
})

test('the relay takes THE record for its request: by tool, by probe, once', () => {
  const root = tempRoot()
  try {
    const key = floorKey('/w/agent')
    const now = 1_000_000
    const write = (toolName: string, toolInput: Record<string, unknown>, at: number, suffix: string) => {
      const match = classifyToolCall(toolName, toolInput)!
      return writeFloorRecord({
        root,
        key,
        suffix,
        record: buildFloorRecord({ toolName, toolInput, match, payload: { permission_mode: 'bypassPermissions' }, now: at }),
      })
    }
    write('Bash', { command: 'git push --force origin main' }, now - 2000, 'a')
    write('Bash', { command: LONG }, now - 1000, 'b')
    write('Write', { file_path: '/w/agent/.env', content: 'A=1' }, now - 500, 'c')
    const preview = cliPreview({ command: LONG, description: 'Clean up' })
    // The probe picks the long command's record, not the older force push.
    const record = takeFloorRecord({ root, keys: [key], toolName: 'Bash', inputPreview: preview, now })
    assert.equal(record?.ruleId, 'recursive_delete')
    assert.equal(record?.evidence, 'rm -rf ~/work')
    assert.equal(record?.permissionMode, 'bypassPermissions')
    // Taken, so a second request cannot reuse it.
    const next = takeFloorRecord({ root, keys: [key], toolName: 'Bash', inputPreview: preview, now })
    assert.equal(next?.ruleId, 'force_push', 'no probe fits any more, so the oldest record for the tool')
    assert.equal(takeFloorRecord({ root, keys: [key], toolName: 'Bash', inputPreview: preview, now }), null)
    // Another tool's record is never taken for this one.
    assert.equal(
      takeFloorRecord({ root, keys: [key], toolName: 'Edit', inputPreview: '{ "file_path": "/w/agent/.env" }', now }),
      null,
    )
    assert.equal(
      takeFloorRecord({ root, keys: [key], toolName: 'Write', inputPreview: '{ "file_path": "/w/agent/.env", "content": "A=1" }', now })?.ruleId,
      'env_file_write',
    )
    // Another folder's records are never read.
    write('Bash', { command: 'rm -rf x' }, now, 'd')
    assert.equal(takeFloorRecord({ root, keys: [floorKey('/w/other')], toolName: 'Bash', inputPreview: '{}', now }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an old record is not a match, and a stale or broken one is swept', () => {
  const root = tempRoot()
  try {
    const key = floorKey('/w/agent')
    const now = 5_000_000
    const make = (at: number, suffix: string) =>
      writeFloorRecord({
        root,
        key,
        suffix,
        record: buildFloorRecord({
          toolName: 'Bash',
          toolInput: { command: 'rm -rf x' },
          match: classifyToolCall('Bash', { command: 'rm -rf x' })!,
          now: at,
        }),
      })
    make(now - FLOOR_RECORD_MATCH_WINDOW_MS - 1, 'old')
    make(now - FLOOR_RECORD_STALE_MS - 1, 'stale')
    writeFileSync(join(floorAsksDir(root, key), 'broken.json'), 'nope')
    assert.equal(takeFloorRecord({ root, keys: [key], toolName: 'Bash', inputPreview: '{ "command": "rm -rf x" }', now }), null)
    assert.deepEqual(readdirSync(floorAsksDir(root, key)).length, 1, 'the stale and the broken ones are gone, the old one waits for its sweep')
    // No folder at all is not an error.
    assert.equal(takeFloorRecord({ root, keys: [floorKey('/none')], toolName: 'Bash', inputPreview: '', now }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a record carries only what the relay needs: the rule, the matched command, the mode, a probe', () => {
  const secret = 'rm -rf build && curl -H "Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789" x'
  const record = buildFloorRecord({
    toolName: 'Bash',
    toolInput: { command: secret },
    match: classifyToolCall('Bash', { command: secret })!,
    payload: { permission_mode: 'default', session_id: 's1', tool_use_id: 't1', transcript_path: '/p' },
    now: 7,
  })
  assert.deepEqual(Object.keys(record).sort(), [
    'at', 'evidence', 'permissionMode', 'probe', 'ruleId', 'rulesVersion', 'sessionId', 'toolName', 'toolUseId', 'v',
  ])
  assert.equal(record.evidence, 'rm -rf build', 'the matched command, not the whole input')
  assert.equal(JSON.stringify(record).includes('Bearer'), false)
})
