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
  GROUP_TURN_HEAD,
  inertMemberText,
  groupTurnText,
  groupCallPathNote,
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
/** Where a group lane may never reach below Full: generic paths. The lane's own folder is outside all of them. */
const FENCE = {
  home: '/home/u', configDir: '/home/u/.claude', stateRoot: '/home/u/.bgos-agent',
  laneRoot: '/var/tmp/hoai-group-lanes-1000/7', laneFolder: '/var/tmp/hoai-group-lanes-1000/7/123',
  tempRoots: ['/tmp/claude-1000', '/private/tmp/claude-1000'], sandbox: false,
}
const FENCED = ['/home/u', '/work/atlas', '/home/u/.bgos-agent', '/home/u/.claude']
const FILE_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write']

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

test('approvals: the owner\'s settings off, only its six tools by name (Bash too), mode default, every prompt to the gate', () => {
  const args = groupLaneArgs({ ...base, resume: false, level: 'approvals', fence: FENCE })
  assert.deepEqual(args, [
    ...HEAD, '--setting-sources', '', '--tools', 'Bash,Read,Grep,Glob,Edit,Write', '--permission-mode', 'default', '--permission-prompt-tool', 'stdio',
    '--settings', JSON.stringify(groupLaneSettings('approvals', '/work/atlas', 'linux', FENCE)), ...MCP_TAIL,
  ])
  assert.ok(!args.includes('--restricted'), 'restricted would take Bash away, so a shell request could never reach the card')
  assert.equal(JSON.parse(after(args, '--settings')!).remoteControlAtStartup, false)
})

test('full: the owner\'s own settings and default tools, mode default, every prompt to the owner\'s own chat handling', () => {
  assert.deepEqual(groupLaneArgs({ ...base, resume: false, level: 'full' }), [
    ...HEAD, '--permission-mode', 'default', '--permission-prompt-tool', 'stdio',
    '--settings', JSON.stringify(groupLaneSettings('full', '/work/atlas', 'linux')), ...MCP_TAIL,
  ])
})

test('a fresh session names its id with --session-id; a later start resumes it; never a fork, never bypass', () => {
  for (const level of ['talk', 'approvals', 'full'] as GroupLevel[]) {
    const fresh = groupLaneArgs({ ...base, resume: false, level, fence: FENCE })
    assert.equal(after(fresh, '--session-id'), ID)
    assert.ok(!fresh.includes('--resume'))
    const resumed = groupLaneArgs({ ...base, resume: true, level, fence: FENCE })
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

test('review 1: full denies reads of the agent folder\'s .hoai (the owner\'s thread worktrees)', () => {
  const full = groupLaneSettings('full', '/work/atlas', 'linux') as { permissions?: { deny?: string[] }; remoteControlAtStartup: boolean }
  assert.deepEqual(full.permissions?.deny, ['Read(//work/atlas/.hoai/**)'])
  assert.equal(full.remoteControlAtStartup, false)
  const args = groupLaneArgs({ ...base, resume: false, level: 'full' })
  assert.deepEqual(JSON.parse(after(args, '--settings')!).permissions.deny, ['Read(//work/atlas/.hoai/**)'])
})

// -- round 3: the boundary below Full -------------------------------------------

type Settings = { permissions: { allow?: string[]; ask?: string[]; deny?: string[]; additionalDirectories?: string[] }; sandbox?: Record<string, any> }

test('boundary: approvals sends EVERY Bash, Read, Grep, Glob, Edit and Write call to the gate: no allow, no widened folder', () => {
  const s = groupLaneSettings('approvals', '/work/atlas', 'linux', FENCE) as Settings
  assert.deepEqual(s.permissions.ask, ['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write'])
  assert.equal(s.permissions.allow, undefined, 'no allow rule: nothing runs without the gate')
  assert.equal(s.permissions.additionalDirectories, undefined, 'no folder widens reads')
})

test('boundary: approvals denies Read, Grep, Glob, Edit and Write on the home folder, the agent folder, ~/.bgos-agent and the CLI config dir', () => {
  const s = groupLaneSettings('approvals', '/work/atlas', 'linux', FENCE) as Settings
  const expected = FENCED.flatMap((p) => FILE_TOOLS.map((tool) => `${tool}(/${p}/**)`))
  assert.deepEqual(s.permissions.deny, expected)
})

test('boundary: with a sandbox Bash is confined (denyRead and denyWrite on the same paths) and never allowed by the sandbox alone', () => {
  const s = groupLaneSettings('approvals', '/work/atlas', 'linux', { ...FENCE, sandbox: true }) as Settings
  assert.deepEqual(s.sandbox, {
    enabled: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    filesystem: {
      denyRead: [...FENCED, '/var/tmp/hoai-group-lanes-1000/7', '/tmp/claude-1000', '/private/tmp/claude-1000'],
      allowRead: ['/var/tmp/hoai-group-lanes-1000/7/123'],
      denyWrite: FENCED,
    },
  })
  assert.ok(s.permissions.ask!.includes('Bash'), 'Bash still asks every time')
})

test('boundary: without a sandbox there is no sandbox block, and Bash still asks every time while the deny rules still refuse the reads', () => {
  const s = groupLaneSettings('approvals', '/work/atlas', 'linux', FENCE) as Settings
  assert.equal(s.sandbox, undefined)
  assert.ok(s.permissions.ask!.includes('Bash'))
  assert.ok(s.permissions.deny!.includes('Read(//home/u/.bgos-agent/**)'))
})

test('boundary (finding B): an agent folder that IS the home folder is fenced the same, each path once', () => {
  const s = groupLaneSettings('approvals', '/home/u', 'linux', { ...FENCE, sandbox: true }) as Settings
  const paths = ['/home/u', '/home/u/.bgos-agent', '/home/u/.claude']
  assert.deepEqual(s.sandbox!.filesystem.denyWrite, paths)
  assert.deepEqual(s.permissions.deny, paths.flatMap((p) => FILE_TOOLS.map((tool) => `${tool}(/${p}/**)`)))
  assert.equal(s.permissions.allow, undefined)
})

test('boundary: approvals refuses to run without its fence, or with a lane folder inside a fenced path', () => {
  assert.throws(() => groupLaneSettings('approvals', '/work/atlas', 'linux'), /fence/)
  for (const laneFolder of ['/home/u/.bgos-agent/7/groups/123', '/work/atlas/.hoai/groups/123', '/home/u', '/home/u/.claude/x']) {
    assert.throws(() => groupLaneSettings('approvals', '/work/atlas', 'linux', { ...FENCE, laneFolder }), /lane folder/, laneFolder)
  }
  assert.throws(() => groupLaneArgs({ ...base, resume: false, level: 'approvals' }), /fence/)
})

test('boundary: talk stays reply only (no tools at all), whatever the fence', () => {
  const args = groupLaneArgs({ ...base, resume: false, level: 'talk', fence: FENCE })
  assert.equal(after(args, '--tools'), '')
  assert.equal(after(args, '--permission-mode'), 'dontAsk')
})

// -- round 4: an allow list of tools by name ------------------------------------

test('round 4, finding 1: below Full the lane is launched with ONLY its tools, by name, never the CLI\'s default set', () => {
  // Measured live on CLI 2.1.319: `--tools Bash,Read,Grep,Glob,Edit,Write` offers exactly those six, so ListAgents,
  // SendMessage and anything a later CLI adds are not there at all. A lane replies with its final text: no reply tool.
  const approvals = groupLaneArgs({ ...base, resume: false, level: 'approvals', fence: FENCE })
  assert.equal(after(approvals, '--tools'), 'Bash,Read,Grep,Glob,Edit,Write')
  assert.equal(approvals.filter((a) => a === '--tools').length, 1)
  assert.notEqual(after(approvals, '--tools'), 'default', 'never the default set')
  const talk = groupLaneArgs({ ...base, resume: false, level: 'talk', fence: FENCE })
  assert.equal(after(talk, '--tools'), '')
  const s = groupLaneSettings('approvals', '/work/atlas', 'linux', FENCE) as Settings
  assert.deepEqual(s.permissions.ask, ['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write'], 'each listed tool asks, every time')
  assert.equal(s.permissions.allow, undefined)
  // Full keeps the owner's own tools, as in their own chat.
  assert.ok(!groupLaneArgs({ ...base, resume: false, level: 'full' }).includes('--tools'))
})

// -- round 4, finding 2: confined to the group's own folder ----------------------

test('round 4, finding 2: the sandbox reads only the group\'s OWN folder of the lane root, and none of the CLI\'s temp output roots', () => {
  const s = groupLaneSettings('approvals', '/work/atlas', 'linux', { ...FENCE, sandbox: true }) as Settings
  const fs = s.sandbox!.filesystem
  assert.ok(fs.denyRead.includes('/var/tmp/hoai-group-lanes-1000/7'), 'the lane root, so every other group\'s folder')
  assert.deepEqual(fs.allowRead, ['/var/tmp/hoai-group-lanes-1000/7/123'], 'reopened for this group only')
  for (const temp of ['/tmp/claude-1000', '/private/tmp/claude-1000']) assert.ok(fs.denyRead.includes(temp), temp)
})

test('round 4, finding 2: the card shows the real resolved path, and says so plainly when it is outside this group\'s folder', () => {
  const lane = '/var/tmp/hoai-group-lanes-1000/7/123'
  const links: Record<string, string> = { '/var/tmp/hoai-group-lanes-1000/7/123/cfg': '/home/u/.claude' }
  const realpath = (p: string) => {
    for (const [from, to] of Object.entries(links)) if (p === from || p.startsWith(from + '/')) return to + p.slice(from.length)
    return p
  }
  assert.equal(groupCallPathNote('Read', { file_path: `${lane}/notes.txt` }, lane, realpath), `Path: ${lane}/notes.txt`)
  assert.equal(groupCallPathNote('Read', { file_path: 'notes.txt' }, lane, realpath), `Path: ${lane}/notes.txt`, 'relative to the lane folder')
  assert.equal(
    groupCallPathNote('Read', { file_path: '../456/other.txt' }, lane, realpath),
    'Path: /var/tmp/hoai-group-lanes-1000/7/456/other.txt. This is OUTSIDE this group\'s folder.',
  )
  assert.equal(
    groupCallPathNote('Edit', { file_path: `${lane}/cfg/settings.json` }, lane, realpath),
    'Path: /home/u/.claude/settings.json. This is OUTSIDE this group\'s folder.',
    'a link is resolved to where it really points',
  )
  assert.equal(groupCallPathNote('Grep', { pattern: 'x', path: '/etc' }, lane, realpath), 'Path: /etc. This is OUTSIDE this group\'s folder.')
  assert.equal(groupCallPathNote('Glob', { pattern: '*' }, lane, realpath), `Path: ${lane}`, 'no path is the working folder')
  assert.equal(groupCallPathNote('Bash', { command: 'ls' }, lane, realpath), `Runs in: ${lane}`)
})

// -- round 5 (A): member text is never interpreted by the CLI ---------------------

test('round 5 A: every @ is neutralised, and a line that starts with a CLI prefix is made literal', () => {
  const WJ = '⁠'
  assert.equal(inertMemberText('see @../456/x and @~/a'), `see @${WJ}../456/x and @${WJ}~/a`)
  assert.equal(inertMemberText(inertMemberText('@x')), `@${WJ}x`, 'once, however often it runs')
  assert.equal(inertMemberText('/config permissionMode=auto'), `${WJ}/config permissionMode=auto`)
  assert.equal(inertMemberText('hi\n/list-agents'), `hi\n${WJ}/list-agents`)
  for (const p of ['!', '#', '&', '/']) assert.equal(inertMemberText(`  ${p}x`), `  ${WJ}${p}x`, p)
  assert.equal(inertMemberText('a/b and 5 # 6'), 'a/b and 5 # 6', 'only a line start counts')
})

test('round 5 A: a turn NEVER starts with member text: the message, the sender and the frame come after a fixed line', () => {
  const turn = groupTurnText({ frame: null, text: '/config permissionMode=auto', sender: null })
  assert.equal(turn.split('\n')[0], GROUP_TURN_HEAD)
  assert.ok(GROUP_TURN_HEAD.startsWith('['))
  assert.ok(!/(^|\n)[ \t]*\//.test(turn), 'no line starts with a slash')
  const framed = groupTurnText({ frame: '/usage', text: '[BGOS group: x]\n@../456/y', sender: '@Ana', serverFramed: true })
  assert.equal(framed.split('\n')[0], GROUP_TURN_HEAD)
  assert.ok(!/@(?!⁠)/.test(framed), 'every @ neutralised')
  assert.ok(!/(^|\n)[ \t]*[/!#&]/.test(framed))
})

test('round 5 A: the seed neutralises the title, note, summary, roster, backlog and earlier messages too', () => {
  const seed = groupSeedBrief({
    title: '/x @t', level: 'talk', note: '@n', summary: '\n/s', frame: null, text: '@m', sender: '@s',
    roster: [{ name: '@r', role: 'member' }], agents: ['@a'], backlog: [{ sender: '@b', text: '/c @d' }],
    earlier: [{ messageId: 1, sender: '@e', text: '@f', sentAt: null }],
  })
  assert.ok(seed.startsWith('[You are working in the group'))
  assert.ok(!/@(?!⁠)/.test(seed), seed)
  assert.ok(!/(^|\n)[ \t]*[/!#&]/.test(seed))
})

// -- round 6: effort keywords in member text ----------------------------------------

test('round 6, finding 1: an effort keyword in member text is made literal (a word joiner inside it), case blind, and still reads the same', () => {
  const WJ = '⁠'
  assert.equal(inertMemberText('please ultrathink about it'), `please ultra${WJ}think about it`)
  assert.equal(inertMemberText('ULTRATHINK'), `ULTRA${WJ}THINK`)
  assert.equal(inertMemberText('UltraThink.'), `Ultra${WJ}Think.`)
  for (const w of ['ultracode', 'ultraplan', 'ultrareview']) assert.equal(inertMemberText(w), `ultra${WJ}${w.slice(5)}`, w)
  assert.equal(inertMemberText(inertMemberText('ultrathink')), `ultra${WJ}think`, 'once, however often it runs')
  assert.equal(inertMemberText('ultra think, think hard').replace(/⁠/g, ''), 'ultra think, think hard', 'the text reads the same')
  assert.equal(inertMemberText('please ultrathink').replace(/⁠/g, ''), 'please ultrathink')
})

test('round 6, finding 1: no builder lets an effort keyword through, in any field', () => {
  const seed = groupSeedBrief({
    title: 'ultrathink team', level: 'talk', note: 'ULTRATHINK', summary: 'UltraThink', frame: 'ultrathink', text: 'ultrathink', sender: 'ultrathink',
    roster: [{ name: 'ultrathink', role: 'member' }], agents: ['ultrathink'], backlog: [{ sender: 'ultrathink', text: 'ultrathink' }],
    earlier: [{ messageId: 1, sender: 'ultrathink', text: 'ultrathink', sentAt: null }],
  })
  assert.ok(!/ultrathink/i.test(seed), 'no bare keyword left')
  const turn = groupTurnText({ frame: 'ultrathink', text: 'ultrathink', sender: 'ultrathink', earlier: [{ messageId: 2, sender: null, text: 'UltraThink', sentAt: null }] })
  assert.ok(!/ultrathink/i.test(turn))
})
