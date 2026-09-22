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
 * before redaction) is the one that turns it red. Stage 7 added the same case
 * at the OTHER end of the string, where the output keeps its tail: its
 * mutation is clipping the output before masking it at the mapper's call site.
 *
 * Two more mutations, from the stage 7 review:
 *   - drop the private key block branch  -> the PEM body line case goes red
 *   - mask a value with maskSecret        -> the short password case goes red
 * Stage 8 adds the same case for the third string a row can carry, a child
 * agent's last message, where the cut keeps the HEAD rather than the tail:
 *   - cut the last message before masking it -> the helper result case goes red
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  TOOL_ARGS_MAX,
  TOOL_OUTPUT_LINES_MAX,
  TOOL_OUTPUT_MAX,
  applyHookEventToTurn,
  clipForWire,
  emptyTurn,
  parseHookEvent,
  redactForWire,
  shortenPath,
  shortenPathsInText,
  summarizeToolArgs,
  type Effect,
} from '../lib/hook-events.ts'
import { RESULT_MAX, clipResultHead } from '../lib/helpers.ts'
import { clipOutputTail } from '../lib/tool-outcome.ts'

const CWD = '/home/karim/work/bgos'

/** The row a Bash call leaves on the card when it printed this. */
const rowForStdout = (stdout: string) => {
  const payload = (name: string, extra: Record<string, unknown>) => {
    const event = parseHookEvent({
      session_id: 'sess-redact',
      transcript_path: '/home/kc/.claude/projects/-work/sess-redact.jsonl',
      cwd: CWD,
      prompt_id: 'p-1',
      hook_event_name: name,
      tool_name: 'Bash',
      tool_use_id: 'toolu_redact',
      tool_input: { command: 'run the thing' },
      ...extra,
    })
    assert.ok(event, 'the payload should parse')
    return event
  }
  const opened = applyHookEventToTurn(emptyTurn(), payload('PreToolUse', {}), 1_000)
  const closed = applyHookEventToTurn(
    opened.next,
    payload('PostToolUse', {
      duration_ms: 7,
      tool_response: { stdout, stderr: '', interrupted: false, isImage: false },
    }),
    1_100,
  )
  const card = closed.effects.find((e: Effect) => e.kind === 'tool_card')
  assert.ok(card && card.kind === 'tool_card', 'expected a tool_card effect')
  return card.tools[0]!
}

/** The row a child agent leaves behind when its last message said this. */
const helperRowFor = (lastMessage: string) => {
  const payload = (name: string, extra: Record<string, unknown>) => {
    const event = parseHookEvent({
      session_id: 'sess-redact',
      transcript_path: '/home/kc/.claude/projects/-work/sess-redact.jsonl',
      cwd: CWD,
      prompt_id: 'p-1',
      hook_event_name: name,
      ...extra,
    })
    assert.ok(event, 'the payload should parse')
    return event
  }
  const agent = {
    tool_name: 'Agent',
    tool_use_id: 'toolu_helper',
    tool_input: { subagent_type: 'general-purpose', description: 'find the thing' },
  }
  const opened = applyHookEventToTurn(emptyTurn(), payload('PreToolUse', agent), 1_000)
  const launched = applyHookEventToTurn(
    opened.next,
    payload('PostToolUse', {
      ...agent,
      duration_ms: 5,
      tool_response: { isAsync: true, status: 'async_launched', agentId: 'agent-1' },
    }),
    1_005,
  )
  const stopped = applyHookEventToTurn(
    launched.next,
    payload('SubagentStop', {
      agent_id: 'agent-1',
      agent_type: 'general-purpose',
      last_assistant_message: lastMessage,
    }),
    9_000,
  )
  const card = stopped.effects.find((e: Effect) => e.kind === 'tool_card')
  assert.ok(card && card.kind === 'tool_card', 'expected a tool_card effect')
  return card.tools[0]!
}

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

test('REDACT THEN CLIP: a secret at the 2048 character output boundary is still masked', () => {
  // The same defect as the 120 character case above, at the other end of the
  // string: the output keeps its TAIL, so a token that starts just before the
  // cut would ship its LAST characters in the clear if the clip ran first.
  const token = `ZZtok${'b'.repeat(35)}`
  const tail = token.slice(-19)
  const stdout = `curl -H "Authorization: Bearer ${token}" ${'x'.repeat(2027)}`
  assert.equal(stdout.length, 2100)
  const cut = stdout.length - TOOL_OUTPUT_MAX
  assert.ok(cut > stdout.indexOf(token), 'the fixture must start the token before the cut')
  assert.ok(cut < stdout.indexOf(token) + token.length, 'and end it after the cut')

  const output = rowForStdout(stdout).output ?? ''
  assert.ok(output.length <= TOOL_OUTPUT_MAX)
  assert.ok(!output.includes(tail), 'the live tail of the token reached the wire')
  assert.ok(output.includes('bearer_token]'), 'what is left of the mask says what was there')

  // The wrong order, spelled out: clipping first hides the token from the scan.
  const clippedFirst = redactForWire(clipOutputTail(stdout, TOOL_OUTPUT_MAX, TOOL_OUTPUT_LINES_MAX))
  assert.ok(
    clippedFirst.includes(tail),
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

test('a private key block goes body and all, not just its BEGIN line', () => {
  // Every rule is line anchored and the private key rule matches the header
  // alone, so the base64 body lines that follow match NOTHING and a pass that
  // looked at one line at a time stored the key in the clear. The key below is
  // a fake, shaped like an ed25519 one.
  const lines = [
    'running ssh-keygen',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gt',
    'ZWQyNTUxOQAAACBGQUtFRkFLRUZBS0VGQUtFRkFLRUZBS0VGQUtFRkFLRUZBAAAAoGZh',
    '-----END OPENSSH PRIVATE KEY-----',
    'done',
  ]
  const out = redactForWire(lines.join('\n'))

  for (const body of lines.slice(2, 4)) {
    assert.ok(!out.includes(body), `a base64 body line survived: ${body}`)
  }
  assert.ok(!out.includes('-----END'), 'the END line goes with the body it closes')
  assert.equal(
    out,
    ['running ssh-keygen', '[redacted:private_key_block]', '[private key removed]', 'done'].join('\n'),
    'the whole block collapses to two lines and the text around it is untouched',
  )

  // And end to end, on the row the card actually ships: the output block is
  // what a `cat ~/.ssh/id_ed25519` would have put on the wire.
  const row = rowForStdout(lines.join('\n'))
  for (const body of lines.slice(2, 4)) {
    assert.ok(!(row.output ?? '').includes(body), 'the key reached the row output')
  }
})

test('a private key with no END line takes the rest of the text with it', () => {
  // A tail clipped log, a crash mid print: the header is the only proof there
  // is, so it has to be enough on its own.
  const out = redactForWire(
    ['-----BEGIN RSA PRIVATE KEY-----', 'MIIBOgIBAAJBAKFAKEFAKEFAKEFAKE', 'still the key'].join('\n'),
  )
  assert.equal(out, '[redacted:private_key_block]\n[private key removed]')

  const header = redactForWire('-----BEGIN RSA PRIVATE KEY-----')
  assert.equal(header, '[redacted:private_key_block]', 'a header on its own invents no body line')

  const oneLine = redactForWire('-----BEGIN PRIVATE KEY-----MIIBOgIBAAJBAKFAKEFAKE-----END PRIVATE KEY-----')
  assert.ok(!oneLine.includes('MIIBOgIBAAJBAKFAKEFAKE'), 'a one line PEM carries its body beside the header')
})

test('a certificate is not a private key: only the key block is swallowed', () => {
  const text = ['-----BEGIN CERTIFICATE-----', 'MIIDdzCCAl+gAwIBAgIEAgAAuTAN', '-----END CERTIFICATE-----'].join('\n')
  assert.equal(redactForWire(text), text, 'a public certificate is not a secret and reads as evidence')
})

test('a secret shorter than its own excerpt is replaced whole, never excerpted', () => {
  // maskSecret is a four character EXCERPT plus three dots, which is a display
  // format: substituting it back into the text would store a three character
  // password intact. What goes on the wire is the placeholder, so the length
  // of the value cannot matter.
  const out = redactForWire('psql postgres://bgos:abc@db.internal/bgos')
  assert.equal(out, 'psql postgres://bgos:[redacted:connection_string_password]@db.internal/bgos')
  assert.ok(!out.includes(':abc@'), 'the password survived')
  assert.ok(!out.includes('abc...'), 'an excerpt is not a redaction')
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

test('REDACT THEN CLIP: a secret straddling the 240 character result cut is still masked', () => {
  // The third string a row can carry, and the one whose cut keeps the HEAD: a
  // child agent's last message. The token is positioned so that a cut made
  // first would leave twelve of its characters behind the prefix: too short for
  // the rule to see, long enough to be the live head of a real key.
  const token = `sk-ant-api03-${'A'.repeat(35)}`
  const pad = 'padding '.repeat(27)
  const message = `${pad}${token} is the key I used`
  const head = token.slice(0, RESULT_MAX - 1 - pad.length)
  assert.equal(head.length, 23, 'ten characters of the body: below what the rule can see')
  assert.ok(message.indexOf(token) < RESULT_MAX, 'the fixture must start the token before the cut')
  assert.ok(message.indexOf(token) + token.length > RESULT_MAX, 'and end it after the cut')

  const result = helperRowFor(message).result ?? ''
  assert.ok(result.length <= RESULT_MAX, 'the wire cap is 240')
  assert.ok(result.includes('[redacted:anthropic'), 'what is left of the mask says what was there')
  assert.ok(!result.includes(head), 'the head of the token reached the wire')

  // The wrong order, spelled out: cutting first hides the token from the scan.
  const cutFirst = redactForWire(clipResultHead(message, RESULT_MAX))
  assert.ok(
    cutFirst.includes(head),
    'this fixture only proves the rule if the wrong order really does leak',
  )
})
