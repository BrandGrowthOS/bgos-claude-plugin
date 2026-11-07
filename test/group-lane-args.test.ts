/**
 * The pure half of group threads (lib/group-lane-args.ts): the level mapped
 * onto the permission mode and the gate (never a tool list for the group), a
 * fresh session that never forks nor touches the main session, the seed brief
 * and its cap, and the pause summary.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  GROUP_SEED_MAX_CHARS,
  assertGroupLane,
  groupLaneArgs,
  groupLevel,
  groupSeedBrief,
  groupStampChatId,
  isGroupSilent,
  parseGroupSummary,
  type GroupLevel,
} from '../lib/group-lane-args.ts'

const MAIN = '435f1f18-2716-4c27-bfd8-e2c48f28b3ac'
const ID = '11111111-1111-4111-8111-111111111111'
const base = { sessionId: ID, emptyMcpConfigPath: '/tmp/empty-mcp.json', agentFolder: '/work/atlas', mainSessionId: MAIN, platform: 'linux' as const }
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

test('the level: talk, approvals and full; anything else is approvals (fail closed)', () => {
  assert.equal(groupLevel('talk'), 'talk')
  assert.equal(groupLevel('approvals'), 'approvals')
  assert.equal(groupLevel('full'), 'full')
  for (const raw of [undefined, null, '', 'FULL', 'admin', 3, {}]) assert.equal(groupLevel(raw), 'approvals', String(raw))
})

test('talk: no tools at all and dontAsk, so the lane can only answer; nobody is asked', () => {
  const args = groupLaneArgs({ ...base, resume: false, level: 'talk' })
  assert.equal(after(args, '--tools'), '')
  assert.equal(after(args, '--permission-mode'), 'dontAsk')
  assert.ok(args.includes('--restricted'))
  assert.ok(!args.includes('--permission-prompt-tool'))
})

test('approvals: restricted (the owner\'s allow rules do not apply), mode default, every prompt to the daemon\'s gate', () => {
  const args = groupLaneArgs({ ...base, resume: false, level: 'approvals' })
  assert.ok(args.includes('--restricted'))
  assert.equal(after(args, '--tools'), 'default', 'the CLI\'s own set, never a hand made list')
  assert.equal(after(args, '--permission-mode'), 'default')
  assert.equal(after(args, '--permission-prompt-tool'), 'stdio')
  const settings = JSON.parse(after(args, '--settings')!)
  assert.deepEqual(settings.permissions.allow, ['Read(//work/atlas/**)'])
  assert.equal(settings.remoteControlAtStartup, false)
})

test('full: the owner\'s own settings and mode default, every prompt to the same gate as the owner\'s chat', () => {
  const args = groupLaneArgs({ ...base, resume: false, level: 'full' })
  assert.ok(!args.includes('--restricted'))
  assert.ok(!args.includes('--tools'))
  assert.equal(after(args, '--permission-mode'), 'default')
  assert.equal(after(args, '--permission-prompt-tool'), 'stdio')
  assert.deepEqual(JSON.parse(after(args, '--settings')!), { remoteControlAtStartup: false })
})

test('a fresh session names its id with --session-id; a later start resumes it; never a fork, never bypass', () => {
  for (const level of ['talk', 'approvals', 'full'] as GroupLevel[]) {
    const fresh = groupLaneArgs({ ...base, resume: false, level })
    assert.equal(after(fresh, '--session-id'), ID)
    assert.ok(!fresh.includes('--resume'))
    const resumed = groupLaneArgs({ ...base, resume: true, level })
    assert.equal(after(resumed, '--resume'), ID)
    for (const args of [fresh, resumed]) {
      assert.ok(!args.includes('--fork-session'))
      assert.ok(!args.includes('--dangerously-skip-permissions'))
      assert.deepEqual(args.slice(-3), ['--strict-mcp-config', '--mcp-config', '/tmp/empty-mcp.json'])
    }
  }
})

test('a group lane never runs on the owner\'s main session, nor forks, nor continues', () => {
  assert.throws(() => groupLaneArgs({ ...base, sessionId: MAIN, resume: true, level: 'approvals' }), /main session/)
  assert.throws(() => groupLaneArgs({ ...base, sessionId: 'not-a-uuid', resume: true, level: 'approvals' }), /UUID/)
  assert.throws(() => assertGroupLane(['--resume', MAIN, '--strict-mcp-config'], MAIN), /main session/)
  assert.throws(() => assertGroupLane(['--fork-session', '--strict-mcp-config'], MAIN), /--fork-session/)
  assert.throws(() => assertGroupLane(['--continue', '--strict-mcp-config'], null), /--continue/)
})

test('the stamp: only group:<positive integer> names a group', () => {
  assert.equal(groupStampChatId('group:123'), '123')
  for (const stamp of ['owner', 'person:u1', 'group:', 'group:0', 'group:12a', 'group:../x', null, 5]) assert.equal(groupStampChatId(stamp), null, String(stamp))
})

test('the seed brief stays within about 12,000 characters, the backlog giving way first and the message always kept', () => {
  const backlog = Array.from({ length: 200 }, (_, i) => ({ sender: `P${i}`, text: `line ${i} ${'x'.repeat(100)}` }))
  const brief = groupSeedBrief({
    title: 'Launch team', level: 'approvals', note: 'Note.', summary: 'Prev.', frame: null,
    text: 'THE QUESTION', sender: 'Ana', roster: [{ name: 'Ana', role: 'owner' }], agents: ['Scout'], backlog,
  })
  assert.ok(brief.length <= GROUP_SEED_MAX_CHARS, String(brief.length))
  assert.ok(brief.includes('THE QUESTION'))
  assert.ok(brief.includes('P199'), 'the newest backlog lines stay')
  assert.ok(!brief.includes('P0:'), 'the oldest go first')
  assert.ok(brief.includes('Scout (agent)'))
  assert.ok(brief.includes('Note.') && brief.includes('Prev.'))
})

test('the pause summary: at most 6 lines, its Needs you items read off the last line', () => {
  const parsed = parseGroupSummary('- a\n- b\n- c\n- d\n- e\n- f\n- g\n- Needs you: one; two.')
  assert.equal(parsed.summary.split('\n').length, 6)
  assert.deepEqual(parsed.needsYou, ['one', 'two'])
  assert.deepEqual(parseGroupSummary('- a\nNeeds you: nothing').needsYou, [])
  assert.equal(isGroupSilent('(silent)'), true)
  assert.equal(isGroupSilent('  '), true)
  assert.equal(isGroupSilent('hello'), false)
})
