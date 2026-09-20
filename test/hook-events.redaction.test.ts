/**
 * What may leave the machine on a tool row.
 *
 * lib/secret-scan.ts is the packaging gate for Agent Packs, where a finding
 * BLOCKS. On this rail a finding must REDACT instead: a blocked card would
 * silently kill the whole activity rail, which is the failure class
 * docs/learnings/silence-is-not-proof-of-deafness.md is about.
 *
 * The load bearing ordering rule: REDACT, THEN CLIP. scanText is line and
 * pattern oriented, so cutting a 40 character token down to its first 10 characters
 * first leaves a value no rule matches, and the head of a live secret ships as
 * plain text. The straddle case below is the proof, and its mutation (clip
 * before redaction) is the one that turns it red.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  TOOL_ARGS_MAX,
  clipForWire,
  redactForWire,
  shortenPath,
  shortenPathsInText,
  summarizeToolArgs,
} from '../lib/hook-events.ts'

const CWD = '/home/karim/work/bgos'

test('a Bash command carrying real secrets ships with each one masked by rule', () => {
  const command = [
    'ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"',
    'psql postgres://bgos:hunter2hunter2@db.internal/bgos',
  ].join(' ')
  const out = redactForWire(command)

  assert.ok(!out.includes('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA'), 'the anthropic key survived')
  assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'), 'the aws key id survived')
  assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz012345'), 'the bearer token survived')
  assert.ok(!out.includes('hunter2hunter2'), 'the database password survived')

  assert.match(out, /\[redacted:anthropic_api_key\]/)
  assert.match(out, /\[redacted:aws_access_key_id\]/)
  assert.match(out, /\[redacted:bearer_token\]/)
  assert.match(out, /\[redacted:connection_string_password\]/)

  assert.ok(out.includes('curl'), 'the command is redacted, not thrown away')
  assert.ok(out.includes('psql'))
})

test('a placeholder is left alone, exactly as isPlaceholderValue decides', () => {
  const command = 'deploy --api_key=${API_KEY} --password=<YOUR_PASSWORD>'
  assert.equal(redactForWire(command), command)
})

test('prose with no secret in it is returned unchanged', () => {
  const text = 'yarn jest src/components/chat/__tests__/technicalDetailsFilter.test.ts'
  assert.equal(redactForWire(text), text)
  assert.equal(redactForWire(''), '')
})

test('REDACT THEN CLIP: a secret straddling the 120 character cut is still masked', () => {
  // The token starts at column 109, so a clip at 119 would leave 10 of its 40
  // characters: too short for the bearer rule to see, long enough to be the
  // live head of a real key.
  const token = `ZZtok${'b'.repeat(35)}`
  const head = token.slice(0, 10)
  const command = `${'echo padding '.repeat(6)}curl -H "Authorization: Bearer ${token}" https://api.example.com`
  assert.ok(command.indexOf(token) < TOOL_ARGS_MAX, 'the fixture must start the token before the cut')
  assert.ok(command.indexOf(token) + token.length > TOOL_ARGS_MAX, 'and end it after the cut')

  const redacted = redactForWire(command)
  assert.match(redacted, /\[redacted:bearer_token\]/)
  assert.ok(!redacted.includes(head))

  const args = summarizeToolArgs('Bash', { command }, CWD)
  assert.ok(args.includes('[redacted:'), 'the token must be masked before the clip happens')
  assert.ok(!args.includes(head), 'the head of the token reached the wire')
  assert.ok(args.length <= TOOL_ARGS_MAX)

  // The wrong order, spelled out: clipping first hides the token from the scan.
  const clippedFirst = redactForWire(clipForWire(command, TOOL_ARGS_MAX))
  assert.ok(
    clippedFirst.includes(head),
    'this fixture only proves the rule if the wrong order really does leak',
  )
})

test('a home directory path is reduced before it can name the user', () => {
  assert.equal(shortenPath('/home/karim/.aws/credentials', CWD), '.aws/credentials')
  assert.equal(shortenPath('/Users/kc/Documents/taxes.pdf', CWD), 'Documents/taxes.pdf')
  const args = summarizeToolArgs('Read', { file_path: '/home/karim/.ssh/id_rsa' }, CWD)
  assert.equal(args, '.ssh/id_rsa')
  assert.ok(!args.includes('karim'))
})

test('a secret in a file path is masked too', () => {
  const out = summarizeToolArgs(
    'Bash',
    { command: 'gh auth login --with-token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    CWD,
  )
  assert.match(out, /\[redacted:github_token\]/)
  assert.ok(!out.includes('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))
})

test('a line full of secrets is redacted to the last one, not to the first few', () => {
  const keys = Array.from({ length: 20 }, (_v, i) => `AKIAIOSFODNN7EXAMPL${String.fromCharCode(65 + i)}`)
  const out = redactForWire(keys.join(' '))
  assert.ok(out.length > 0)
  for (const key of keys) {
    assert.ok(!out.includes(key), `${key} survived: a bounded loop must fail closed, not stop early`)
  }
})

// ── absolute paths inside a Bash command ───────────────────────────────

test('a Bash row shortens the paths inside the command, not only the path slot', () => {
  // The path SLOT was shortened from the start; the command itself shipped raw,
  // so the row read `cat /home/karim/.bgos-agent/credentials-901.json` and put
  // the machine layout and the account name on the wire.
  const args = summarizeToolArgs(
    'Bash',
    { command: 'cat /home/karim/.bgos-agent/credentials-901.json && ls /home/karim/work/bgos/backend/src' },
    CWD,
  )
  assert.ok(!args.includes('/home/karim'), `a home directory reached the wire: ${args}`)
  assert.ok(args.includes('~/.bgos-agent/credentials-901.json'), args)
  assert.ok(args.includes('backend/src'), 'the workspace prefix became a relative path')
  assert.ok(!args.includes(CWD), args)
})

test('the shortening happens BEFORE the 120 character clip', () => {
  // Otherwise the clip spends its budget on the machine layout and the row
  // ends mid path, saying nothing about what the command did.
  const command = `grep -rn "createTurnChatTracker" ${CWD}/frontend/expo-app/src/components/chat/mission --include=*.tsx`
  const args = summarizeToolArgs('Bash', { command }, CWD)
  assert.ok(args.length <= TOOL_ARGS_MAX)
  assert.ok(
    args.includes('frontend/expo-app/src/components/chat/mission'),
    `the readable part survived the clip: ${args}`,
  )
})

test('shortenPathsInText leaves everything that is not a path alone', () => {
  assert.equal(shortenPathsInText('', CWD), '')
  assert.equal(shortenPathsInText('echo hello', CWD), 'echo hello')
  assert.equal(shortenPathsInText('cd /home/karim', CWD), 'cd ~')
  assert.equal(shortenPathsInText('cd /Users/kc/notes', CWD), 'cd ~/notes')
  assert.equal(
    shortenPathsInText('type C:\\Users\\kc\\agent\\log.txt', CWD),
    'type ~\\agent\\log.txt',
    'a Windows home is a home too',
  )
  assert.equal(shortenPathsInText(`ls ${CWD}`, CWD), 'ls .', 'the cwd itself is "here"')
  assert.equal(shortenPathsInText('ls /etc/hosts', CWD), 'ls /etc/hosts', 'a system path is not private')
})
