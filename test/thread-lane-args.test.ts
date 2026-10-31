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
  READ_ONLY_DISALLOWED_TOOLS,
  SUMMARY_INSTRUCTION,
  asideArgs,
  asidePrompt,
  assertForksMain,
  isFinalReply,
  threadLaneArgs,
  threadTurnPrompt,
} from '../lib/thread-lane-args.ts'

const MAIN = '435f1f18-2716-4c27-bfd8-e2c48f28b3ac'
const FORK = 'dbd3b62b-f099-4f95-be1d-4687b4af9042'
const MCP = '/state/threads/empty-mcp.json'

test('a lane first start forks the main session, reads stream json on stdin, and loads no MCP server', () => {
  assert.deepEqual(threadLaneArgs({ mainSessionId: MAIN, forkSessionId: null, emptyMcpConfigPath: MCP }), [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--resume', MAIN, '--fork-session',
    '--strict-mcp-config', '--mcp-config', MCP,
  ])
})

test('a lane later start resumes its OWN session id, with no --fork-session and never the main id', () => {
  const args = threadLaneArgs({ mainSessionId: MAIN, forkSessionId: FORK, emptyMcpConfigPath: MCP })
  assert.deepEqual(args, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--resume', FORK,
    '--strict-mcp-config', '--mcp-config', MCP,
  ])
  assert.equal(args.includes(MAIN), false)
  assert.equal(args.includes('--fork-session'), false)
})

test('a later start needs no main id at all: the lane is its own session', () => {
  assert.deepEqual(
    threadLaneArgs({ mainSessionId: null, forkSessionId: FORK, emptyMcpConfigPath: MCP }).slice(6, 8),
    ['--resume', FORK],
  )
})

test('a read only lane (folder not a git repository) refuses the editing tools', () => {
  const args = threadLaneArgs({ mainSessionId: MAIN, forkSessionId: null, emptyMcpConfigPath: MCP, readOnly: true })
  const at = args.indexOf('--disallowedTools')
  assert.ok(at > 0, 'the read only lane names the refused tools')
  assert.equal(args[at + 1], 'Edit,Write,MultiEdit,NotebookEdit')
  assert.equal(READ_ONLY_DISALLOWED_TOOLS, 'Edit,Write,MultiEdit,NotebookEdit')
  // The variadic --mcp-config stays last so it never swallows another flag's value.
  assert.deepEqual(args.slice(-3), ['--strict-mcp-config', '--mcp-config', MCP])
})

test('a lane whose stored fork id IS the main id is refused, never resumed without the fork flag', () => {
  assert.throws(
    () => threadLaneArgs({ mainSessionId: MAIN, forkSessionId: MAIN, emptyMcpConfigPath: MCP }),
    /fork-session/,
  )
})

test('ids that are not UUIDs are refused, so junk never reaches --resume', () => {
  assert.throws(() => threadLaneArgs({ mainSessionId: 'nope', forkSessionId: null, emptyMcpConfigPath: MCP }), /session id/)
  assert.throws(() => threadLaneArgs({ mainSessionId: MAIN, forkSessionId: '--fork-session', emptyMcpConfigPath: MCP }), /session id/)
  assert.throws(() => threadLaneArgs({ mainSessionId: null, forkSessionId: null, emptyMcpConfigPath: MCP }), /session id/)
  assert.throws(() => asideArgs({ mainSessionId: '', emptyMcpConfigPath: MCP }), /session id/)
  assert.throws(() => threadLaneArgs({ mainSessionId: MAIN, forkSessionId: null, emptyMcpConfigPath: '' }), /MCP config/)
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
