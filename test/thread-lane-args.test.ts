/**
 * The pure command builders for thread lanes and By the way (Threads phase 1,
 * plan "Plugin (PR 2)" task 1, spec 8.4 and 19).
 *
 * The one invariant that matters most: a command that resumes the MAIN
 * session always carries --fork-session. A `-p --resume <main>` without it on
 * a running session would send the question or the thread's turn as that
 * session's next turn, into the chat the person is using.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  ASIDE_HISTORY_MAX,
  ASIDE_INSTRUCTION,
  READ_ONLY_DENIED_TOOLS,
  SUMMARY_INSTRUCTION,
  THREAD_LANE_FORBIDDEN_FLAGS,
  THREAD_LANE_READ_ONLY_TOOLS,
  THREAD_LANE_TOOLS,
  THREAD_TEXT_CLIPPED_NOTE,
  THREAD_TEXT_MAX,
  asideArgs,
  asidePrompt,
  assertConfined,
  assertForksMain,
  clipThreadText,
  isFinalReply,
  protectedGitPaths,
  threadLaneArgs,
  threadLaneSettings,
  threadLaneTools,
  threadTurnPrompt,
} from '../lib/thread-lane-args.ts'

const MAIN = '435f1f18-2716-4c27-bfd8-e2c48f28b3ac'
const FORK = 'dbd3b62b-f099-4f95-be1d-4687b4af9042'
const MCP = '/state/threads/empty-mcp.json'

const ROOT = '/work/atlas/.hoai/threads/101'
const WORK = { root: ROOT, readOnly: false, shellSandbox: true, protectedPaths: ['/work/atlas/.git/index'], platform: 'darwin' as const }
const READ_ONLY = { root: ROOT, readOnly: true, shellSandbox: true, readDirs: ['/work/atlas'], platform: 'darwin' as const }

function flag(args: readonly string[], name: string): string {
  const at = args.indexOf(name)
  assert.ok(at >= 0, `${name} is present`)
  return args[at + 1]!
}

test('a lane first start forks the main session, reads stream json on stdin, runs confined, and loads no MCP server', () => {
  assert.deepEqual(threadLaneArgs({ mainSessionId: MAIN, forkSessionId: null, emptyMcpConfigPath: MCP, confinement: WORK }), [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--resume', MAIN, '--fork-session',
    '--restricted',
    '--tools', 'Bash,Read,Edit,Write,Glob,Grep,NotebookEdit,WebFetch,WebSearch',
    '--permission-mode', 'acceptEdits',
    '--settings', JSON.stringify(threadLaneSettings(WORK)),
    '--strict-mcp-config', '--mcp-config', MCP,
  ])
})

test('a lane later start resumes its OWN session id, with no --fork-session and never the main id', () => {
  const args = threadLaneArgs({ mainSessionId: MAIN, forkSessionId: FORK, emptyMcpConfigPath: MCP, confinement: WORK })
  assert.deepEqual(args.slice(0, 8), [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--resume', FORK,
  ])
  assert.equal(args[8], '--restricted')
  assert.equal(args.includes(MAIN), false)
  assert.equal(args.includes('--fork-session'), false)
})

test('a later start needs no main id at all: the lane is its own session', () => {
  assert.deepEqual(
    threadLaneArgs({ mainSessionId: null, forkSessionId: FORK, emptyMcpConfigPath: MCP, confinement: WORK }).slice(6, 8),
    ['--resume', FORK],
  )
})

test('a working lane never inherits the owner permissions: --restricted, edits and reads only under its worktree, Bash in the sandbox', () => {
  const settings = threadLaneSettings(WORK)
  assert.deepEqual(settings, {
    permissions: {
      allow: [`Read(/${ROOT}/**)`, `Edit(/${ROOT}/**)`, 'Bash(git add:*)', 'Bash(git commit:*)'],
      deny: [],
      additionalDirectories: [ROOT],
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      // Without this one argument would undo the sandbox (spike S6).
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite: ['/work/atlas/.git/index'] },
    },
    remoteControlAtStartup: false,
  })
  const args = threadLaneArgs({ mainSessionId: MAIN, forkSessionId: null, emptyMcpConfigPath: MCP, confinement: WORK })
  assert.ok(args.includes('--restricted'), 'user, project and local settings are ignored, the file tools confined')
  assert.equal(flag(args, '--permission-mode'), 'acceptEdits')
  assert.deepEqual(JSON.parse(flag(args, '--settings')), settings)
  for (const forbidden of THREAD_LANE_FORBIDDEN_FLAGS) assert.equal(args.includes(forbidden), false, forbidden)
  assert.equal(args.includes('bypassPermissions'), false)
})

test('a working lane on a host with no Bash sandbox gets no Bash at all, never an unconfined one', () => {
  const c = { ...WORK, shellSandbox: false }
  const tools = flag(threadLaneArgs({ mainSessionId: MAIN, forkSessionId: null, emptyMcpConfigPath: MCP, confinement: c }), '--tools')
  assert.equal(tools.split(',').includes('Bash'), false)
  assert.deepEqual(threadLaneTools(c), THREAD_LANE_TOOLS.filter((t) => t !== 'Bash'))
  const settings = threadLaneSettings(c) as { permissions: { allow: string[]; deny: string[] }; sandbox?: unknown }
  assert.deepEqual(settings.permissions.deny, ['Bash'])
  assert.equal(settings.permissions.allow.some((r) => r.startsWith('Bash(')), false)
  assert.equal(settings.sandbox, undefined)
})

test('a read only lane (folder not a git repository) has no Bash and no editing tool, refuses them, and reads the agent folder', () => {
  const args = threadLaneArgs({ mainSessionId: MAIN, forkSessionId: null, emptyMcpConfigPath: MCP, confinement: READ_ONLY })
  assert.equal(flag(args, '--tools'), 'Read,Glob,Grep,WebFetch,WebSearch')
  assert.deepEqual(THREAD_LANE_READ_ONLY_TOOLS, ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])
  assert.equal(flag(args, '--permission-mode'), 'dontAsk', 'anything not allowed is refused, never asked')
  assert.deepEqual(JSON.parse(flag(args, '--settings')), {
    permissions: {
      allow: ['Read(//work/atlas/**)'],
      deny: ['Bash', 'Edit', 'Write', 'NotebookEdit'],
      additionalDirectories: ['/work/atlas'],
    },
    remoteControlAtStartup: false,
  })
  assert.deepEqual(READ_ONLY_DENIED_TOOLS, ['Bash', 'Edit', 'Write', 'NotebookEdit'])
  // The variadic --mcp-config stays last so it never swallows another flag's value.
  assert.deepEqual(args.slice(-3), ['--strict-mcp-config', '--mcp-config', MCP])
})

test('assertConfined refuses a lane command without its confinement or with a bypass', () => {
  const good = threadLaneArgs({ mainSessionId: MAIN, forkSessionId: null, emptyMcpConfigPath: MCP, confinement: WORK })
  assert.doesNotThrow(() => assertConfined(good))
  for (const missing of ['--restricted', '--tools', '--permission-mode', '--settings']) {
    assert.throws(() => assertConfined(good.filter((a) => a !== missing)), new RegExp(missing), missing)
  }
  assert.throws(() => assertConfined([...good, '--dangerously-skip-permissions']), /dangerously/)
  assert.throws(() => assertConfined([...good, '--add-dir', '/']), /add-dir/)
  assert.throws(() => assertConfined([...good, '--permission-mode', 'bypassPermissions']), /bypassPermissions/)
  assert.throws(() => threadLaneArgs({ mainSessionId: MAIN, forkSessionId: null, emptyMcpConfigPath: MCP, confinement: { ...WORK, root: 'relative/dir' } }), /absolute/)
})

test('the source repository git state a lane may not write: index, HEAD, packed-refs, other branches, other worktrees', () => {
  assert.deepEqual(
    protectedGitPaths({
      commonDir: '/work/atlas/.git',
      ownGitDir: '/work/atlas/.git/worktrees/101',
      ownBranch: 'hoai/thread-101',
      branches: ['refs/heads/main', 'refs/heads/hoai/thread-101', 'refs/heads/hoai/thread-102', 'refs/heads/feature/x', 'refs/tags/v1', 'refs/heads/../../x'],
      worktreeNames: ['101', '102', '../x'],
    }),
    [
      '/work/atlas/.git/index',
      '/work/atlas/.git/HEAD',
      '/work/atlas/.git/packed-refs',
      '/work/atlas/.git/refs/heads/main',
      '/work/atlas/.git/refs/heads/hoai/thread-102',
      '/work/atlas/.git/refs/heads/feature/x',
      '/work/atlas/.git/worktrees/102',
    ],
  )
})

test('a thread message longer than the server holds is cut, with a plain note saying so', () => {
  assert.equal(THREAD_TEXT_MAX, 20_000)
  const short = 'x'.repeat(THREAD_TEXT_MAX)
  assert.equal(clipThreadText(short), short)
  const long = 'y'.repeat(THREAD_TEXT_MAX + 5)
  const clipped = clipThreadText(long)
  assert.equal(clipped.length, THREAD_TEXT_MAX)
  assert.ok(clipped.endsWith(THREAD_TEXT_CLIPPED_NOTE))
  assert.match(THREAD_TEXT_CLIPPED_NOTE, /cut here: a thread message holds at most 20,000 characters/)
  // A surrogate pair at the cut is never split.
  const emoji = 'a'.repeat(THREAD_TEXT_MAX - THREAD_TEXT_CLIPPED_NOTE.length - 1) + '\u{1F600}' + 'z'.repeat(50)
  const cut = clipThreadText(emoji)
  assert.ok(cut.length <= THREAD_TEXT_MAX)
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), false)
})

test('a lane whose stored fork id IS the main id is refused, never resumed without the fork flag', () => {
  assert.throws(
    () => threadLaneArgs({ mainSessionId: MAIN, forkSessionId: MAIN, emptyMcpConfigPath: MCP, confinement: WORK }),
    /fork-session/,
  )
})

test('ids that are not UUIDs are refused, so junk never reaches --resume', () => {
  assert.throws(() => threadLaneArgs({ mainSessionId: 'nope', forkSessionId: null, emptyMcpConfigPath: MCP, confinement: WORK }), /session id/)
  assert.throws(() => threadLaneArgs({ mainSessionId: MAIN, forkSessionId: '--fork-session', emptyMcpConfigPath: MCP, confinement: WORK }), /session id/)
  assert.throws(() => threadLaneArgs({ mainSessionId: null, forkSessionId: null, emptyMcpConfigPath: MCP, confinement: WORK }), /session id/)
  assert.throws(() => asideArgs({ mainSessionId: '', emptyMcpConfigPath: MCP }), /session id/)
  assert.throws(() => threadLaneArgs({ mainSessionId: MAIN, forkSessionId: null, emptyMcpConfigPath: '', confinement: WORK }), /MCP config/)
})

test('an aside forks the main session, has no tools at all, one turn, and streams partial messages', () => {
  assert.deepEqual(asideArgs({ mainSessionId: MAIN, emptyMcpConfigPath: MCP }), [
    '-p', '--resume', MAIN, '--fork-session',
    // The spike (docs/thread-lanes-spike.md): dontAsk alone let Read run.
    '--tools', '',
    '--permission-mode', 'dontAsk', '--max-turns', '1',
    '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--strict-mcp-config', '--mcp-config', MCP,
  ])
})

test('assertForksMain throws on --resume <main> without --fork-session, in every spelling', () => {
  assert.throws(() => assertForksMain(['-p', '--resume', MAIN], MAIN), /fork-session/)
  assert.throws(() => assertForksMain(['-p', `--resume=${MAIN}`], MAIN), /fork-session/)
  assert.throws(() => assertForksMain(['-p', '-r', MAIN], MAIN), /fork-session/)
  assert.throws(() => assertForksMain(['-p', '--continue'], MAIN), /fork-session/)
})

test('assertForksMain accepts a fork of the main session and a resume of any other session', () => {
  assert.doesNotThrow(() => assertForksMain(['-p', '--resume', MAIN, '--fork-session'], MAIN))
  assert.doesNotThrow(() => assertForksMain(['-p', '--fork-session', '--resume', MAIN], MAIN))
  assert.doesNotThrow(() => assertForksMain(['-p', '--resume', FORK], MAIN))
})

test('the aside instruction rides INSIDE the user message, with the quote and the question', () => {
  const text = asidePrompt('What did you decide about the cache?', 'We keep the 5 minute TTL.', [])
  assert.ok(text.startsWith(ASIDE_INSTRUCTION))
  assert.equal(
    ASIDE_INSTRUCTION,
    '[Side question from the owner. Answer only from what you already know in this conversation. Do not use tools. Do not resume or steer the main task.]',
  )
  assert.match(text, /About this message: We keep the 5 minute TTL\./)
  assert.ok(text.trimEnd().endsWith('What did you decide about the cache?'))
})

test('an aside without a quote names no message', () => {
  assert.doesNotMatch(asidePrompt('Why?', '', []), /About this message/)
})

test('an aside carries at most the 20 newest earlier exchanges, oldest first', () => {
  const history = Array.from({ length: 25 }, (_, i) => ({ q: `q${i}`, a: `a${i}` }))
  const text = asidePrompt('now?', '', history)
  assert.equal(ASIDE_HISTORY_MAX, 20)
  assert.doesNotMatch(text, /\bq4\b/)
  assert.match(text, /\bq5\b[\s\S]*\ba5\b[\s\S]*\bq24\b[\s\S]*\ba24\b/)
  assert.ok(text.indexOf('q5') < text.indexOf('q24'))
})

test('a thread start tells the lane it is a separate conversation in its own folder', () => {
  const text = threadTurnPrompt({ mode: 'start', text: 'Look at the flaky test.', title: 'Flaky test', rootText: 'CI is red again.' })
  assert.equal(
    text,
    '[You are now working in a thread of this chat titled "Flaky test". It is a separate conversation about this message: CI is red again. Work on it in this folder only. The main conversation continues without you.]\n\nLook at the flaky test.',
  )
})

test('a read only thread start says so', () => {
  const text = threadTurnPrompt({ mode: 'start', text: 'x', title: 't', rootText: 'r', readOnly: true })
  assert.match(text, /read only/)
  assert.match(text, /do not edit/i)
})

test('a thread reply is the text as is, and a summary asks for the summary only', () => {
  assert.equal(threadTurnPrompt({ mode: 'reply', text: 'And the logs?', title: 't', rootText: 'r' }), 'And the logs?')
  assert.equal(threadTurnPrompt({ mode: 'summary', text: 'ignored', title: 't', rootText: 'r' }), SUMMARY_INSTRUCTION)
  assert.equal(
    SUMMARY_INSTRUCTION,
    '[Write a short summary of this thread for the main chat: what was asked, what you did, the outcome and any open point. Markdown bullets, at most 8 lines. Reply with the summary only.]',
  )
})

test('a reply is final unless it ends asking a question', () => {
  assert.equal(isFinalReply('Fixed it, the test passes.'), true)
  assert.equal(isFinalReply('Shall I open a PR?'), false)
  assert.equal(isFinalReply('Shall I open a PR?  \n'), false)
  assert.equal(isFinalReply('Is it? No. It is done.'), true)
})
