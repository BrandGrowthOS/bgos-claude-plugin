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
  groupLaneSettings,
  groupIdleOverrideMs,
  groupIdlePauseMs,
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

// The exact commands, pinned. Measured on the installed CLI (2.1.319) by the tools its init frame offers:
//  - `--restricted --tools ""` offers no tool at all (talk);
//  - under `--restricted`, `--tools default` offers the default set WITHOUT Bash, WebFetch, Monitor, Workflow and
//    CronCreate, and a named list offers exactly the names (`default,Bash` offered Bash alone): the shell could
//    only be refused, never asked for, so approvals does NOT run restricted;
//  - `--setting-sources "" --tools default` offers the full default set with Bash, and ignores the owner's user,
//    project and local settings (their model and deny rules did not apply), while `--settings` still does.
const MCP_TAIL = ['--strict-mcp-config', '--mcp-config', '/tmp/empty-mcp.json']
const HEAD = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', ID]

test('talk: exactly no tools and dontAsk, so the lane can only answer; nobody is asked', () => {
  assert.deepEqual(groupLaneArgs({ ...base, resume: false, level: 'talk' }), [
    ...HEAD, '--restricted', '--tools', '', '--permission-mode', 'dontAsk',
    '--settings', JSON.stringify(groupLaneSettings('talk', '/work/atlas', 'linux')), ...MCP_TAIL,
  ])
})

test('approvals: the owner\'s settings off, the CLI\'s full default tools (Bash too), mode default, every prompt to the gate', () => {
  const args = groupLaneArgs({ ...base, resume: false, level: 'approvals' })
  assert.deepEqual(args, [
    ...HEAD, '--setting-sources', '', '--tools', 'default', '--permission-mode', 'default', '--permission-prompt-tool', 'stdio',
    '--settings', JSON.stringify(groupLaneSettings('approvals', '/work/atlas', 'linux')), ...MCP_TAIL,
  ])
  assert.ok(!args.includes('--restricted'), 'restricted would take Bash away, so a shell request could never reach the card')
  const settings = JSON.parse(after(args, '--settings')!)
  assert.deepEqual(settings.permissions.allow, ['Read(//work/atlas/**)'], 'reads of the agent folder only; nothing that changes is allowed ahead')
  assert.deepEqual(settings.permissions.deny, ['Read(//work/atlas/.hoai/**)'], 'no tool is denied ahead (each changing use asks the owner); only reads of .hoai are')
  assert.equal(settings.remoteControlAtStartup, false)
})

test('full: the owner\'s own settings and default tools, mode default, every prompt to the owner\'s own chat handling', () => {
  assert.deepEqual(groupLaneArgs({ ...base, resume: false, level: 'full' }), [
    ...HEAD, '--permission-mode', 'default', '--permission-prompt-tool', 'stdio',
    '--settings', JSON.stringify(groupLaneSettings('full', '/work/atlas', 'linux')), ...MCP_TAIL,
  ])
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

test('the idle pause: 15, 30 or 60 minutes, anything else 30', () => {
  assert.equal(groupIdlePauseMs(15), 15 * 60_000)
  assert.equal(groupIdlePauseMs(30), 30 * 60_000)
  assert.equal(groupIdlePauseMs(60), 60 * 60_000)
  for (const raw of [undefined, null, 0, 45, -15, '15', 15.5, NaN]) assert.equal(groupIdlePauseMs(raw), 30 * 60_000, String(raw))
})

test('HOAI_GROUP_LANE_IDLE_MS is read only as a positive whole number of ms, and ignored otherwise', () => {
  assert.equal(groupIdleOverrideMs('60000'), 60_000)
  assert.equal(groupIdleOverrideMs(' 1500 '), 1500)
  for (const raw of [undefined, '', '0', '-5', '1.5', '1e4', 'abc', '60s', '99999999999', '007']) {
    assert.equal(groupIdleOverrideMs(raw), null, String(raw))
  }
})

test('review 1: approvals and full deny reads of the agent folder\'s .hoai (other groups, the owner\'s thread worktrees)', () => {
  const approvals = groupLaneSettings('approvals', '/work/atlas', 'linux') as { permissions: { allow: string[]; deny?: string[] } }
  assert.deepEqual(approvals.permissions.deny, ['Read(//work/atlas/.hoai/**)'])
  assert.deepEqual(approvals.permissions.allow, ['Read(//work/atlas/**)'], 'the owner\'s other files stay readable (spec 3); deny beats allow')
  const full = groupLaneSettings('full', '/work/atlas', 'linux') as { permissions?: { deny?: string[] }; remoteControlAtStartup: boolean }
  assert.deepEqual(full.permissions?.deny, ['Read(//work/atlas/.hoai/**)'])
  assert.equal(full.remoteControlAtStartup, false)
  for (const level of ['approvals', 'full'] as const) {
    const args = groupLaneArgs({ ...base, resume: false, level })
    assert.deepEqual(JSON.parse(after(args, '--settings')!).permissions.deny, ['Read(//work/atlas/.hoai/**)'], level)
  }
})
