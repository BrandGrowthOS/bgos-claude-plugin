/**
 * The hard floor's list and classifier (lib/hard-floor-core.mjs behind
 * lib/hard-floor.ts), beyond the shared fixture.
 *
 * The fixture (test/hard-floor-fixture.test.ts) pins the cases both repos
 * must agree on. This file pins what is this plugin's own: the six ids and
 * their words exactly as the spec writes them, the order that decides which
 * rule a card names, the evidence the relay sends when a command is too long
 * to send whole, the preview reader's leniency, and that the core is pure
 * plain JavaScript a bare `node` can load (the hook depends on it).
 *
 * Run with: npx tsx --test test/hard-floor.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import * as core from '../lib/hard-floor-core.mjs'
import {
  HARD_FLOOR_MAX_TEXT,
  HARD_FLOOR_RULES,
  HARD_FLOOR_RULES_VERSION,
  HARD_FLOOR_RULE_IDS,
  classifyCommand,
  classifyFloor,
  classifyPath,
  classifyPermissionRequest,
  classifyToolCall,
  classifyToolName,
  commandFloorMatch,
  hardFloorWords,
  isOwnChannelServer,
  readToolInput,
  splitShellWords,
  toolNameWords,
} from '../lib/hard-floor.ts'

test('the six rules, their ids and their words, exactly as spec section 1 writes them', () => {
  assert.equal(HARD_FLOOR_RULES_VERSION, 1)
  assert.deepEqual(
    HARD_FLOOR_RULES.map((r) => [r.id, r.words]),
    [
      ['recursive_delete', 'deleting a folder and everything in it'],
      ['force_push', 'force pushing, which can overwrite history'],
      ['git_dir_write', 'changing a file inside .git'],
      ['env_file_write', 'changing an .env file'],
      ['home_dotfile_write', 'changing a settings file in your home folder'],
      ['acts_on_owners_behalf', 'sending, posting or paying on your behalf'],
    ],
  )
  assert.deepEqual([...HARD_FLOOR_RULE_IDS], HARD_FLOOR_RULES.map((r) => r.id))
  assert.equal(hardFloorWords('force_push'), 'force pushing, which can overwrite history')
  assert.equal(hardFloorWords('not_a_rule'), null)
  // Frozen: nothing at run time can widen or reword the list.
  assert.ok(Object.isFrozen(HARD_FLOOR_RULES))
  assert.ok(HARD_FLOOR_RULES.every((r) => Object.isFrozen(r)))
})

test('no em or en dash anywhere in the words the owner reads', () => {
  const emDash = String.fromCharCode(0x2014)
  const enDash = String.fromCharCode(0x2013)
  for (const rule of HARD_FLOOR_RULES) {
    assert.ok(!rule.words.includes(emDash) && !rule.words.includes(enDash), rule.id)
  }
})

test('a match carries the rule, the version, the words and what matched', () => {
  const match = classifyToolCall('Bash', { command: 'cd app && rm -rf build', description: 'x' })
  assert.deepEqual(match, {
    ruleId: 'recursive_delete',
    rulesVersion: 1,
    words: 'deleting a folder and everything in it',
    evidence: 'rm -rf build',
  })
  assert.equal(classifyToolCall('Edit', { file_path: '/w/.env' })?.evidence, '/w/.env')
  assert.equal(
    classifyToolCall('mcp__gmail__send_email', {})?.evidence,
    'mcp__gmail__send_email',
  )
})

test('rule order decides which rule a card names when two match', () => {
  // A force push first in the text still names the delete: the list's order,
  // not the command's, is what both repos agree on.
  assert.equal(classifyCommand('git push -f; rm -rf x'), 'recursive_delete')
  // A path that is both an .env file and a home settings file is the .env rule.
  assert.equal(classifyPath('~/.env'), 'env_file_write')
  // Inside .git beats everything else a path could be.
  assert.equal(classifyPath('/home/kc/.git/.env'), 'git_dir_write')
})

test('the shell splitter: segments, quotes removed, quoted text returned for a second read', () => {
  const { segments, quoted } = splitShellWords('cd a && bash -c "rm -rf b" | tee c; echo $(ls)')
  assert.deepEqual(segments, [
    ['cd', 'a'],
    ['bash', '-c', 'rm -rf b'],
    ['tee', 'c'],
    ['echo'],
    ['ls'],
  ])
  assert.deepEqual(quoted, ['rm -rf b'])
  // A backslash before a newline continues the line; elsewhere it is a character.
  assert.deepEqual(splitShellWords('rm -rf \\\n build').segments, [['rm', '-rf', 'build']])
  assert.deepEqual(splitShellWords('rd /s C:\\tmp\\x').segments, [['rd', '/s', 'C:\\tmp\\x']])
  // An escaped quote inside double quotes does not end the string.
  assert.deepEqual(splitShellWords('echo "a \\"b\\" c"').segments, [['echo', 'a "b" c']])
})

test('an unterminated quote or a lone operator never throws and never hides what came before', () => {
  assert.equal(classifyCommand('rm -rf build "'), 'recursive_delete')
  assert.equal(classifyCommand("rm -rf build '"), 'recursive_delete')
  assert.equal(classifyCommand('&&&;;||'), null)
  assert.equal(classifyCommand(''), null)
  assert.equal(classifyCommand('   '), null)
  assert.equal(classifyCommand(undefined), null)
  assert.equal(classifyCommand(42), null)
})

test('the evidence of a long command is the segment that matched, not its head', () => {
  const noise = 'echo ' + 'x'.repeat(6000)
  const match = commandFloorMatch(`${noise} && git push --force origin main`)
  assert.equal(match?.ruleId, 'force_push')
  assert.equal(match?.evidence, 'git push --force origin main')
})

test('quoted text is read as a command, three levels deep and no deeper', () => {
  assert.equal(classifyCommand(`ssh host 'sudo sh -c "rm -rf /srv/x"'`), 'recursive_delete')
  // Nest `sh -c "<inner>"` by hand, escaping the way the splitter unescapes.
  const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const nest = (s: string) => `sh -c ${quote(s)}`
  const three = nest(nest(nest('rm -rf x')))
  const four = nest(three)
  assert.equal(classifyCommand(three), 'recursive_delete', 'three levels of quotes are read')
  // A fourth level is not: the depth is bounded so a pathological input cannot
  // make the hook spend its budget re-reading its own quotes.
  assert.equal(classifyCommand(four), null, 'a fourth level is not read')
})

test('a command past the size limit is read up to the limit, and not beyond', () => {
  const pad = 'x'.repeat(HARD_FLOOR_MAX_TEXT)
  assert.equal(classifyCommand(`rm -rf a ${pad}`), 'recursive_delete')
  assert.equal(classifyCommand(`echo ${pad} && rm -rf a`), null)
})

test('paths: separators, long path prefixes and case do not change the answer', () => {
  assert.equal(classifyPath('C:/work/repo/.GIT/config'), 'git_dir_write')
  assert.equal(classifyPath('\\\\?\\C:\\Users\\kc\\.gitconfig'), 'home_dotfile_write')
  assert.equal(classifyPath('/work//repo///.env'), 'env_file_write')
  assert.equal(classifyPath('/work/repo/.ENV.Local'), 'env_file_write')
  assert.equal(classifyPath(''), null)
  assert.equal(classifyPath(null), null)
  assert.equal(classifyPath('/'), null)
  // Climbing out of the home folder is not a file in it.
  assert.equal(classifyPath('~/../etc/hosts'), null)
  // The home folder itself is not a file.
  assert.equal(classifyPath('/home/kc'), null)
  assert.equal(classifyPath('~'), null)
})

test('tool names: the words, the own channel exemption, and nothing but MCP', () => {
  assert.deepEqual(toolNameWords('sendHTTPPost_now-v2'), ['send', 'http', 'post', 'now', 'v'])
  assert.ok(isOwnChannelServer('bgos'))
  assert.ok(isOwnChannelServer('plugin_hoai_bgos'))
  assert.ok(isOwnChannelServer('plugin_hoaiq_bgos'))
  assert.equal(isOwnChannelServer('gmail'), false)
  assert.equal(isOwnChannelServer('bgos_mirror'), false)
  assert.equal(classifyToolName('mcp__bgos'), null, 'no tool part, no tool')
  assert.equal(classifyToolName('send_email'), null, 'not an MCP tool name')
  assert.equal(classifyToolName('mcp__x__publishing_queue'), 'acts_on_owners_behalf')
  assert.equal(classifyToolName('mcp__x__published_items'), null, 'a past form names a list')
})

test('tool calls: shell by command, edit by path, MCP by name, everything else never', () => {
  assert.equal(classifyToolCall('PowerShell', { command: 'Remove-Item -r x' })?.ruleId, 'recursive_delete')
  assert.equal(classifyToolCall('NotebookEdit', { notebook_path: '/r/.git/n.ipynb' })?.ruleId, 'git_dir_write')
  assert.equal(classifyToolCall('Write', { file_path: '/r/src/a.ts', content: 'rm -rf /' }), null)
  assert.equal(classifyToolCall('Read', { file_path: '/r/.env' }), null)
  assert.equal(classifyToolCall('Agent', { prompt: 'rm -rf everything' }), null)
  assert.equal(classifyToolCall('bash', { command: 'rm -rf x' }), null, 'tool names are exact, like the CLI')
  assert.equal(classifyToolCall('Bash', null), null)
  assert.equal(classifyToolCall('Bash', 'rm -rf x'), null, 'the hook hands an OBJECT; a string is not one')
  assert.equal(classifyToolCall(undefined, undefined), null)
})

test('the preview reader: JSON, JSON cut short, and plain text', () => {
  assert.deepEqual(readToolInput('Bash', '{ "command": "ls -la" }'), { command: 'ls -la' })
  assert.deepEqual(
    readToolInput('Bash', '{ "command": "rm -rf \\"a b\\"\\nls", "description": "x'),
    { command: 'rm -rf "a b"\nls' },
  )
  // An escape cut in half at the very end is dropped, not decoded into junk.
  assert.deepEqual(readToolInput('Bash', '{ "command": "echo \\u00'), { command: 'echo ' })
  assert.deepEqual(readToolInput('Bash', 'rm -rf build'), { command: 'rm -rf build' })
  assert.deepEqual(readToolInput('Write', '/r/.env'), { file_path: '/r/.env' })
  assert.deepEqual(readToolInput('mcp__x__send', 'anything'), {})
  assert.deepEqual(readToolInput('Bash', ''), {})
  assert.deepEqual(readToolInput('Bash', '[1,2]'), { command: '[1,2]' })
  assert.equal(classifyPermissionRequest('Bash', undefined), null)
})

test('classifyFloor reads the four fixture kinds and refuses anything else', () => {
  assert.equal(classifyFloor({ kind: 'command', command: 'rm -rf x' })?.ruleId, 'recursive_delete')
  assert.equal(classifyFloor({ kind: 'path', path: '/r/.env' })?.ruleId, 'env_file_write')
  assert.equal(classifyFloor({ kind: 'tool', toolName: 'mcp__a__pay' })?.ruleId, 'acts_on_owners_behalf')
  assert.equal(
    classifyFloor({ kind: 'request', toolName: 'Bash', inputPreview: '{"command":"git push -f"}' })?.ruleId,
    'force_push',
  )
  assert.equal(classifyFloor({ kind: 'nonsense' } as never), null)
  assert.equal(classifyFloor(null as never), null)
})

test('the typed surface is the core, not a second copy of it', () => {
  // One implementation (see lib/hard-floor.ts): the list the daemon reads IS
  // the list the hook reads.
  assert.equal(HARD_FLOOR_RULES, core.HARD_FLOOR_RULES)
  assert.equal(HARD_FLOOR_RULES_VERSION, core.HARD_FLOOR_RULES_VERSION)
  assert.equal(splitShellWords, core.splitShellWords)
  const src = readFileSync(new URL('../lib/hard-floor.ts', import.meta.url), 'utf8')
  assert.equal(/new RegExp|\/\^/.test(src), false, 'no pattern of its own in the typed surface')
})

test('the core is pure plain JavaScript that a bare node can load', () => {
  const src = readFileSync(new URL('../lib/hard-floor-core.mjs', import.meta.url), 'utf8')
  // No imports at all: the hook loads it on node 18, with no loader.
  assert.equal(/^\s*import\s/m.test(src), false, 'the core imports nothing')
  assert.equal(/\brequire\(/.test(src), false)
  // No env, no clock, no network, no exit.
  for (const banned of ['process.', 'Date.now', 'fetch(', 'setTimeout']) {
    assert.equal(src.includes(banned), false, `the core must not use ${banned}`)
  }
  // No TypeScript syntax a node without a loader would choke on.
  assert.equal(/^\s*(export\s+)?(interface|type)\s+\w+/m.test(src), false)
  assert.equal(/\)\s*:\s*[A-Z][A-Za-z]+\s*[{=]/.test(src), false, 'no annotated signatures')
})
