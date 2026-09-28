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
  HOAI_AGENT_BROWSER_SERVERS,
  HOAI_OWN_SERVERS,
  isAgentBrowserServer,
  isOwnChannelServer,
  lexShell,
  previewIsElided,
  quoteWords,
  readToolInput,
  redirectEvidence,
  toolNameWords,
} from '../lib/hard-floor.ts'
import { HARD_FLOOR_FIXTURE } from '../lib/hard-floor-fixture.ts'

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
      ['acts_on_owners_behalf', 'sending, posting, paying or deleting on your behalf'],
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

test('the shell reader: simple commands, quotes removed, a comment and a heredoc body are not commands', () => {
  const words = (text: string) => lexShell(text).commands.map((c) => c.words)
  assert.deepEqual(words('cd a && bash -c "rm -rf b" | tee c; echo $(ls)'), [
    ['cd', 'a'],
    ['bash', '-c', 'rm -rf b'],
    ['tee', 'c'],
    ['echo'],
    ['ls'],
  ])
  // A backslash before a newline continues the line; before a plain letter it is a character.
  assert.deepEqual(words('rm -rf \\\n build'), [['rm', '-rf', 'build']])
  assert.deepEqual(words('rd /s C:\\tmp\\x'), [['rd', '/s', 'C:\\tmp\\x']])
  // An escaped quote inside double quotes does not end the string.
  assert.deepEqual(words('echo "a \\"b\\" c"'), [['echo', 'a "b" c']])
  assert.deepEqual(words('true # ; rm -rf x'), [['true']])
  const heredoc = lexShell("cat > clean.sh <<'EOF'\nrm -rf dist\nEOF\necho ok").commands
  assert.deepEqual(heredoc.map((c) => c.words), [['cat'], ['echo', 'ok']])
  assert.deepEqual(heredoc[0].writes, [{ op: '>', target: 'clean.sh' }], 'a redirect target is a write, not a word')
  assert.deepEqual(heredoc[0].stdin, ['rm -rf dist'], 'the body is the data of the command that owns it')
  // `$(...)` inside double quotes still runs, so it is handed back to be read.
  assert.deepEqual(lexShell('echo "$(rm -rf x)"').nested, ['rm -rf x'])
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

test('a shell\'s script is read as a command, four levels deep and no deeper', () => {
  assert.equal(classifyCommand(`sudo sh -c "rm -rf /srv/x"`), 'recursive_delete')
  // Nest `sh -c "<inner>"` by hand, escaping the way the reader unescapes.
  const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`
  const nest = (s: string) => `sh -c ${quote(s)}`
  const four = nest(nest(nest(nest('rm -rf x'))))
  const five = nest(four)
  assert.equal(classifyCommand(four), 'recursive_delete', 'four levels of scripts are read')
  // A fifth level is not, on either side (the server's MAX_DEPTH is 4): the
  // depth is bounded so a pathological input cannot spend the hook's budget.
  assert.equal(classifyCommand(five), null, 'a fifth level is not read')
})

test('spec 4.2: a mention is not the action, and neither is a comment or a script written to a file', () => {
  // The shapes an agent uses all day, each of which the server says null to.
  // With the switch off, every one of these that asked cost a round trip, a
  // terminal prompt on a personal session, and on an error a REFUSED commit.
  for (const command of [
    'git commit -m "$(cat <<\'EOF\'\nfix: stop the rm -rf of the cache\n\nCo-Authored-By: x\nEOF\n)"',
    'gh pr create --title t --body "$(cat <<\'EOF\'\nnever git push --force to main\nEOF\n)"',
    "rg -n 'git push -f' docs/",
    'grep -rn "rm -rf" scripts/',
    "cat > clean.sh <<'EOF'\nrm -rf dist\nEOF",
    'echo "rm -rf dist" >> Makefile',
    'echo \'rm -rf build\'',
    'true # rm -rf x',
    'alias r="rm -rf"',
  ]) {
    assert.equal(classifyCommand(command), null, command)
  }
  // And the same text fed to a shell is the action.
  assert.equal(classifyCommand("bash <<'EOF'\nrm -rf dist\nEOF"), 'recursive_delete')
  assert.equal(classifyCommand('echo "rm -rf dist" | bash'), 'recursive_delete')
  assert.equal(classifyCommand('echo "$(rm -rf dist)"'), 'recursive_delete')
  assert.equal(classifyCommand("eval 'git push -f'"), 'force_push')
})

test('GNU long option prefixes (--r, --rec, --recur) are in the SHARED fixture now, so both readers are held to them', () => {
  // A3 pinned these on this side only; stage 6 wave B moved them into the
  // byte identical fixture, where the server's spec runs them too.
  const byName = new Map(HARD_FLOOR_FIXTURE.map((c) => [c.name, c]))
  for (const [name, command, ruleId] of [
    ['rm_long_prefix_r', 'rm --r build', 'recursive_delete'],
    ['rm_long_prefix_rec_with_force', 'rm --rec -f build', 'recursive_delete'],
    ['rm_long_prefix_recur', 'rm --recur build', 'recursive_delete'],
    ['rm_long_force_is_not_recursive', 'rm --force build', null],
    ['rm_double_dash_then_a_file_named_like_a_flag', 'rm -- --r', null],
  ] as const) {
    const c = byName.get(name)
    assert.deepEqual(c?.input, { kind: 'command', command }, name)
    assert.equal(c?.ruleId, ruleId, name)
  }
})

test('redirects: a target is a write with its operator, a stream is not a word, and an input is dropped', () => {
  const only = (text: string) => lexShell(text).commands.map((c) => ({ words: c.words, writes: c.writes }))
  assert.deepEqual(only('make 2>> .env'), [{ words: ['make'], writes: [{ op: '2>>', target: '.env' }] }])
  assert.deepEqual(only('a &> out; b 2>&1; c >& file; d <> rw; e < in'), [
    { words: ['a'], writes: [{ op: '&>', target: 'out' }] },
    { words: ['b'], writes: [] },
    { words: ['c'], writes: [{ op: '>&', target: 'file' }] },
    { words: ['d'], writes: [{ op: '<>', target: 'rw' }] },
    { words: ['e'], writes: [] },
  ])
  // `a2` is a word, not a stream; the redirect comes first and the program after it.
  assert.deepEqual(only('echo a2>x'), [{ words: ['echo', 'a2'], writes: [{ op: '>', target: 'x' }] }])
  assert.deepEqual(only('> log rm -rf x'), [{ words: ['rm', '-rf', 'x'], writes: [{ op: '>', target: 'log' }] }])
  // A redirect never outlives its command: the `rm` inside `$(...)` is a command.
  assert.equal(classifyCommand('echo > $(rm -rf y)'), 'recursive_delete')
})

test('the evidence of a shell write is a command the server reads the same way', () => {
  // A redirect: the command's words and only the redirect that matched, operator kept.
  const redirect = commandFloorMatch('npm run build > build.log 2>> .env')
  assert.deepEqual(redirect, { ruleId: 'env_file_write', evidence: 'npm run build 2>> .env' })
  assert.equal(classifyCommand(redirect!.evidence), 'env_file_write')
  assert.equal(redirectEvidence([], { op: '>', target: '.env' }), '> .env')
  assert.equal(redirectEvidence(['echo', 'a b'], { op: '>>', target: 'my .env' }), "echo 'a b' >> 'my .env'")
  // A writer program (tee, sed -i, cp, mv): the whole simple command, not the path alone.
  for (const [command, evidence, ruleId] of [
    ["echo 'alias ll=ls' | sudo tee -a ~/.bashrc", 'sudo tee -a ~/.bashrc', 'home_dotfile_write'],
    ["sed -i 's/a/b/' .env", 'sed -i s/a/b/ .env', 'env_file_write'],
    ['cd app && cp -t .git/hooks pre-commit', 'cp -t .git/hooks pre-commit', 'git_dir_write'],
    ['git fetch && git push --mirror backup', 'git push --mirror backup', 'force_push'],
    ['find build -type f -delete', 'find build -type f -delete', 'recursive_delete'],
  ] as const) {
    const match = commandFloorMatch(command)
    assert.deepEqual(match, { ruleId, evidence }, command)
    assert.equal(classifyCommand(evidence), ruleId, evidence)
  }
  // An edit tool's path is still its own evidence (the relay sends it as the path).
  assert.equal(classifyToolCall('Write', { file_path: '/w/.env', content: 'A=1' })?.evidence, '/w/.env')
})

test('the evidence of every fixture match reads back as the same rule (what the relay sends)', () => {
  let checked = 0
  for (const c of HARD_FLOOR_FIXTURE) {
    if (c.input.kind !== 'command' || c.ruleId === null) continue
    const match = commandFloorMatch(c.input.command)
    assert.equal(match?.ruleId, c.ruleId, c.name)
    assert.equal(classifyCommand(match!.evidence), c.ruleId, `${c.name}: ${match!.evidence}`)
    checked += 1
  }
  assert.ok(checked > 40, `the corpus was walked (${checked})`)
  // Quoting keeps what a word is: a space, a quote, a trailing backslash.
  assert.equal(quoteWords(['rm', '-rf', 'my dir', "it's", 'C:\\x\\']), `rm -rf 'my dir' "it's" 'C:\\x\\'`)
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

test('tool names: the words, the own channel exemption by EXACT name, and nothing but MCP', () => {
  assert.deepEqual(toolNameWords('sendHTTPPost_now-v2'), ['send', 'http', 'post', 'now', 'v2'])
  assert.deepEqual([...HOAI_OWN_SERVERS], ['bgos', 'plugin_hoai_bgos', 'plugin_bgos_bgos', 'plugin_hoaiq_bgos'])
  assert.ok(isOwnChannelServer('bgos'))
  assert.ok(isOwnChannelServer('plugin_hoai_bgos'))
  assert.ok(isOwnChannelServer('plugin_bgos_bgos'))
  assert.ok(isOwnChannelServer('plugin_hoaiq_bgos'))
  assert.equal(isOwnChannelServer('gmail'), false)
  assert.equal(isOwnChannelServer('bgos_mirror'), false)
  // Spec 4.2: never by a pattern. Another plugin that names its server `bgos`
  // is a third party, and its send is on the list.
  assert.equal(isOwnChannelServer('plugin_mail_bgos'), false)
  assert.equal(classifyToolName('mcp__plugin_mail_bgos__send_email'), 'acts_on_owners_behalf')
  assert.equal(classifyToolName('mcp__plugin_hoai_bgos__reply'), null)
  assert.equal(classifyToolName('mcp__bgos'), null, 'no tool part, no tool')
  assert.equal(classifyToolName('send_email'), null, 'not an MCP tool name')
  // Whole words, the server's: a digit or a suffix makes another word.
  assert.equal(classifyToolName('mcp__x__send2'), null)
  assert.equal(classifyToolName('mcp__x__sends_digest'), null)
  assert.equal(classifyToolName('mcp__x__publishing_queue'), null)
  assert.equal(classifyToolName('mcp__x__published_items'), null, 'a past form names a list')
  assert.equal(classifyToolName('mcp__x__publish_post'), 'acts_on_owners_behalf')
})

test("tool names: the Agent Browser's own server is left to its own gate, by EXACT name (the stage 6 backend review)", () => {
  assert.deepEqual([...HOAI_AGENT_BROWSER_SERVERS], ['hoai-browser', 'plugin_hoai_hoai-browser', 'plugin_hoaiq_hoai-browser'])
  for (const name of [
    'mcp__hoai-browser__browser_cookie_delete',
    'mcp__plugin_hoai_hoai-browser__browser_localstorage_delete',
    'mcp__plugin_hoaiq_hoai-browser__browser_sessionstorage_delete',
  ]) {
    assert.equal(classifyToolName(name), null, name)
  }
  // Not the channel, and not a pattern: another plugin's `hoai-browser` is a third party.
  assert.equal(isOwnChannelServer('plugin_hoai_hoai-browser'), false)
  assert.equal(isAgentBrowserServer('plugin_mail_hoai-browser'), false)
  assert.equal(classifyToolName('mcp__plugin_mail_hoai-browser__delete_message'), 'acts_on_owners_behalf')
})

test('tool names: paying in the names payment tools use, a payment noun beside a verb that makes one (the stage 6 backend review)', () => {
  for (const name of [
    'mcp__stripe__create_payment_intent',
    'mcp__stripe__createPayment',
    'mcp__stripe__confirm_payment_intent',
    'mcp__billing__process_payments',
    'mcp__stripe__create_charge',
    'mcp__square__charge_card',
    'mcp__x___charge_card',
  ]) {
    assert.equal(classifyToolName(name), 'acts_on_owners_behalf', name)
  }
  for (const name of [
    'mcp__stripe__list_payment_intents',
    'mcp__stripe__retrieve_payment_intent',
    'mcp__stripe__get_charge',
    'mcp__billing__payment_status',
    'mcp__x__create_report',
  ]) {
    assert.equal(classifyToolName(name), null, name)
  }
})

/**
 * The own channel exemption is tied to the plugin's OWN manifest (P2 stage 6,
 * wave B1b Fix). HOAI_OWN_SERVERS spells the channel's server names by hand,
 * and nothing tied them to `.claude-plugin/plugin.json`: rename the plugin
 * (`hoai`) or its channel server key (`bgos`) and the CLI names the tools
 * `mcp__plugin_<new>_<server>__reply`, which the exact list no longer
 * matches, so every reply, send_to_peer and meeting_reply of the channel
 * itself would become a floor match and ask the owner about talking to the
 * owner. This derives the names the CLI will use from the manifest.
 *
 * MUTATION PROOF (applied to .claude-plugin/plugin.json, confirmed red,
 * restored): "name": "hoai" -> "hoaix" -> this test red
 * (mcp__plugin_hoaix_bgos__reply classified as acts_on_owners_behalf).
 */
test('the plugin manifest\'s own channel server is exempt under the name the CLI gives its tools', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
  ) as { name: string; mcpServers: Record<string, unknown>; channels: Array<{ server: string }> }
  assert.equal(typeof manifest.name, 'string')
  assert.ok(manifest.channels.length > 0, 'the manifest declares its channel')
  for (const { server } of manifest.channels) {
    assert.ok(Object.hasOwn(manifest.mcpServers, server), `channel server ${server} is not an MCP server of the manifest`)
    // The plugin install (mcp__plugin_<plugin>_<server>__<tool>) and the
    // standalone install (mcp__<server>__<tool>, the README's .mcp.json).
    const pluginServer = `plugin_${manifest.name}_${server}`.toLowerCase()
    for (const id of [pluginServer, server.toLowerCase()]) {
      assert.ok(isOwnChannelServer(id), `${id} is this channel's own server and is not in HOAI_OWN_SERVERS`)
      for (const tool of ['reply', 'send_to_peer', 'meeting_reply', 'voice_consult_reply']) {
        assert.equal(classifyToolName(`mcp__${id}__${tool}`), null, `mcp__${id}__${tool} would ask the owner`)
      }
    }
    // The control: the same tool on a server that is not this channel's IS a
    // match, so the null above comes from the exemption and not the words.
    assert.equal(classifyToolName(`mcp__plugin_${manifest.name}x_${server}__reply`), 'acts_on_owners_behalf')
  }
  // The other server the manifest ships is the Agent Browser: NOT the
  // channel, and left to the browser's own gate under the name the CLI gives
  // its tools (HOAI_AGENT_BROWSER_SERVERS), so a rename of the plugin or of
  // the server key is red here rather than turning its storage clearers into
  // floor matches. Any other server the manifest grows is neither.
  for (const server of Object.keys(manifest.mcpServers)) {
    if (manifest.channels.some((c) => c.server === server)) continue
    const id = `plugin_${manifest.name}_${server}`.toLowerCase()
    assert.equal(isOwnChannelServer(id), false, `${server} is not the channel`)
    assert.equal(server, 'hoai-browser', `${server}: a new MCP server in the manifest needs a floor decision`)
    assert.ok(isAgentBrowserServer(id), `${id} is the Agent Browser and is not in HOAI_AGENT_BROWSER_SERVERS`)
    assert.ok(isAgentBrowserServer(server.toLowerCase()), `${server} standalone is not in HOAI_AGENT_BROWSER_SERVERS`)
    assert.equal(classifyToolName(`mcp__${id}__browser_localstorage_delete`), null)
  }
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
  // An escape cut in half at the very end is kept as text, as the server reads it.
  assert.deepEqual(readToolInput('Bash', '{ "command": "echo \\u00'), { command: 'echo \\u00' })
  // The CLI's middle cut (a raw newline inside the string) still reads, head and tail.
  const cut = readToolInput('Bash', '{ "command": "echo a\n\u22EF 12 code points elided \u22EF\nrm -rf x", "description": "d" }')
  assert.equal(cut.command, 'echo a\n\u22EF 12 code points elided \u22EF\nrm -rf x')
  assert.ok(previewIsElided('{ "command": "a\n\u22EF 1 code point elided \u22EF\nb" }'))
  assert.equal(previewIsElided('{ "command": "rm -rf x" }'), false)
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
  assert.equal(lexShell, core.lexShell)
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
