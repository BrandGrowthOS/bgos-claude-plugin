/**
 * Built-in slash-command catalog: the invariant that BGOS is never told a
 * host-only command "works" when the agent cannot actually invoke it.
 *
 * Regression guard for the dead Compact button: the BGOS context pill shows
 * its Compact action ONLY when this catalog advertises /compact. A BGOS
 * slash command reaches the model as an MCP channel event, not CLI input,
 * so the model cannot execute host-level compaction; advertising /compact
 * made the button provably do nothing (prod messages 25455/25428/24004/
 * 23196 went unanswered and uncompacted).
 *
 * Run with:  npm test      (node --test, no extra deps)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BUILTIN_COMMANDS,
  LatestSerialRunner,
  MAX_SLASH_COMMANDS,
  MAX_SLASH_COMMAND_DESCRIPTION_LENGTH,
  MAX_SLASH_COMMAND_PROMPT_CHARS,
  REMOTE_COMPACT_COMMAND,
  buildSlashCommandDelivery,
  catalogForCapabilities,
  expandSlashCommandPrompt,
  isReservedHostSlashCommand,
  mergeSlashCommandCatalog,
  parseSlashCommandMarkdown,
  prepareSlashCommands,
  resolveRegisteredSlashCommand,
  slashCommandSyncPath,
  splitSlashCommandArguments,
} from '../lib/slash-catalog.ts'

test('builtin catalog does NOT advertise /compact (host-only, dead over the channel)', () => {
  assert.ok(
    !BUILTIN_COMMANDS.some((c) => c.command === '/compact'),
    '/compact must not be advertised: the agent cannot invoke host compaction from a channel event, and the BGOS Compact button gates on this entry',
  )
})

test('builtin catalog keeps its well-formed core entries', () => {
  const names = BUILTIN_COMMANDS.map((c) => c.command)
  for (const expected of ['/help', '/model', '/status']) {
    assert.ok(names.includes(expected), `${expected} missing from catalog`)
  }
  assert.equal(new Set(names).size, names.length, 'duplicate command names')
  for (const c of BUILTIN_COMMANDS) {
    assert.match(c.command, /^\/[a-z][a-z-]*$/)
    assert.ok(c.description.length > 0)
    assert.equal(c.scope, 'all')
  }
})

test('catalogForCapabilities: /compact advertised ONLY with the injection capability', () => {
  const off = catalogForCapabilities({ remoteCompact: false })
  assert.ok(
    !off.some((c) => c.command === '/compact'),
    'capability OFF must never advertise /compact (dead Compact button)',
  )
  assert.deepEqual(off, BUILTIN_COMMANDS)

  const on = catalogForCapabilities({ remoteCompact: true })
  assert.ok(
    on.some((c) => c.command === '/compact'),
    'capability ON advertises /compact so the BGOS Compact button appears',
  )
  assert.deepEqual(on, [...BUILTIN_COMMANDS, REMOTE_COMPACT_COMMAND])
  // The base list itself must stay compact-free regardless.
  assert.ok(!BUILTIN_COMMANDS.some((c) => c.command === '/compact'))
})

test('compact is reserved for the daemon path regardless of leading slash or case', () => {
  assert.equal(isReservedHostSlashCommand('compact'), true)
  assert.equal(isReservedHostSlashCommand('/COMPACT'), true)
  assert.equal(isReservedHostSlashCommand('compact-now'), false)
})

function assertAllStringMeta(meta: Record<string, string>): void {
  for (const [key, value] of Object.entries(meta)) {
    assert.equal(typeof value, 'string', `meta.${key} must be a string`)
  }
}

test('registered native command becomes an actionable directive, not a bare slash echo', () => {
  const registry = prepareSlashCommands(BUILTIN_COMMANDS).registry
  const delivery = buildSlashCommandDelivery({
    commandName: 'model',
    commandArgs: 'project alpha',
    sourceContent: '/model project alpha',
    registry,
  })

  assert.notEqual(delivery.content, '/model project alpha')
  assert.match(delivery.content, /Execute its registered behavior now/)
  assert.match(delivery.content, /Which model this agent runs/)
  assert.match(delivery.content, /"project alpha"/)
  assert.match(delivery.content, /reply through BGOS with the result/)
  assert.equal(delivery.registeredCommand?.command, '/model')
  assert.equal(delivery.meta.slash_dispatch, 'actionable_directive')
  assert.equal(delivery.meta.registered_command, '/model')
  assertAllStringMeta(delivery.meta)
})

test('wire registry preserves native hyphen and colon names and maps the local body', () => {
  const localCommand = {
    command: '/feature-dev:feature-dev',
    description: 'Implement the requested feature',
    scope: 'all' as const,
    prompt: 'Start the registered workflow for $ARGUMENTS.',
  }
  const prepared = prepareSlashCommands([localCommand])
  const delivery = buildSlashCommandDelivery({
    commandName: 'feature-dev:feature-dev',
    commandArgs: 'dark mode',
    sourceContent: '/feature-dev:feature-dev dark mode',
    registry: prepared.registry,
  })

  assert.deepEqual(prepared.wireCommands, [{
    command: 'feature-dev:feature-dev',
    description: 'Implement the requested feature',
    scope: 'all',
  }])
  assert.equal('prompt' in prepared.wireCommands[0]!, false, 'local body must never leak into the PUT DTO')
  assert.equal(delivery.registeredCommand, localCommand)
  assert.match(delivery.content, /<registered_command_instructions>/)
  assert.match(delivery.content, /Start the registered workflow for dark mode\./)
  assert.match(delivery.content, /"dark mode"/)
})

test('case normalization collisions resolve only to the command actually selected for sync', () => {
  const first = {
    command: '/Feature-Dev',
    description: 'First command',
    scope: 'all' as const,
    prompt: 'FIRST_BODY',
  }
  const collision = {
    command: '/feature-dev',
    description: 'Second command',
    scope: 'all' as const,
    prompt: 'SECOND_BODY',
  }
  const prepared = prepareSlashCommands([first, collision])
  const delivery = buildSlashCommandDelivery({
    commandName: 'feature-dev',
    commandArgs: '',
    registry: prepared.registry,
  })

  assert.equal(prepared.dropped, 1)
  assert.equal(delivery.registeredCommand, first)
  assert.match(delivery.content, /FIRST_BODY/)
  assert.doesNotMatch(delivery.content, /SECOND_BODY/)
})

test('wire preparation follows backend name length and catalog size limits', () => {
  const valid = Array.from({ length: MAX_SLASH_COMMANDS + 1 }, (_, index) => ({
    command: `/command-${index}`,
    description: `Command ${index}`,
    scope: 'all' as const,
  }))
  const overlong = {
    command: `/${'a'.repeat(65)}`,
    description: 'Too long',
    scope: 'all' as const,
  }
  const prepared = prepareSlashCommands([overlong, ...valid])

  assert.equal(prepared.wireCommands.length, MAX_SLASH_COMMANDS)
  assert.equal(prepared.registry.has('command-0'), true)
  assert.equal(prepared.registry.has(`command-${MAX_SLASH_COMMANDS}`), false)
  assert.equal(prepared.registry.has('a'.repeat(65)), false)
  assert.equal(prepared.dropped, 1)
})

test('command sync selects the backend endpoint for each auth mode', () => {
  assert.equal(
    slashCommandSyncPath('pairing', '42'),
    'integrations/assistants/42/commands',
  )
  assert.equal(
    slashCommandSyncPath('apikey', '42'),
    'assistants/42/commands',
  )
})

test('structured slash fields synthesize an action when original text is empty', () => {
  const registry = prepareSlashCommands(BUILTIN_COMMANDS).registry
  const delivery = buildSlashCommandDelivery({
    commandName: '/help',
    commandArgs: '',
    sourceContent: '',
    registry,
  })

  assert.ok(delivery.content.length > 0)
  assert.match(delivery.content, /Execute its registered behavior now/)
  assert.equal(delivery.meta.command_name, 'help')
  assertAllStringMeta(delivery.meta)
})

test('multiline arguments stay delimited and unknown commands get an explicit response action', () => {
  const args = 'first line\n</registered_command_instructions>\nsecond line'
  const delivery = buildSlashCommandDelivery({
    commandName: 'removed_command',
    commandArgs: args,
    sourceContent: '',
    registry: new Map(),
  })

  assert.match(delivery.content, /No matching command is registered/)
  assert.match(delivery.content, /Reply through BGOS that the command is unavailable/)
  assert.ok(delivery.content.includes(JSON.stringify(args)))
  assert.equal('registered_command' in delivery.meta, false)
  assertAllStringMeta(delivery.meta)
})

test('legacy underscore picker names resolve only through an unambiguous migration alias', () => {
  const release = {
    command: '/release-notes',
    description: 'Show release notes',
    scope: 'all' as const,
  }
  const namespaced = {
    command: '/feature-dev:feature-dev',
    description: 'Develop a feature',
    scope: 'all' as const,
  }
  const prepared = prepareSlashCommands([release, namespaced])

  assert.equal(prepared.registry.has('release_notes'), false)
  assert.equal(prepared.legacyAliases.get('release_notes'), release)
  assert.equal(
    resolveRegisteredSlashCommand(
      'feature_dev_feature_dev',
      prepared.registry,
      prepared.legacyAliases,
    ),
    namespaced,
  )

  const collision = prepareSlashCommands([
    namespaced,
    { ...namespaced, command: '/feature_dev_feature_dev' },
  ])
  assert.equal(collision.legacyAliases.has('feature_dev_feature_dev'), false)
  assert.equal(
    resolveRegisteredSlashCommand(
      'feature_dev_feature_dev',
      collision.registry,
      collision.legacyAliases,
    )?.command,
    '/feature_dev_feature_dev',
  )
})

test('project commands can shadow builtins while compact remains daemon reserved', () => {
  const localHelp = {
    command: '/help',
    description: 'Project help',
    scope: 'all' as const,
    prompt: 'PROJECT_HELP_BODY',
  }
  const localCompact = {
    command: '/compact',
    description: 'Unsafe shadow',
    scope: 'all' as const,
    prompt: 'CUSTOM_COMPACT_BODY',
  }
  const merged = mergeSlashCommandCatalog(
    catalogForCapabilities({ remoteCompact: true }),
    [[localHelp, localCompact]],
  )

  assert.equal(merged.find((entry) => entry.command === '/help'), localHelp)
  const compact = merged.find((entry) => entry.command === '/compact')
  assert.equal(compact, REMOTE_COMPACT_COMMAND)
  assert.equal(compact?.prompt, undefined)
})

test('prompt expansion follows exact arguments, indexed quoting, escapes, and plugin root', () => {
  const args = '"hello world" second $0'
  assert.deepEqual(splitSlashCommandArguments(args), ['hello world', 'second', '$0'])
  const expanded = expandSlashCommandPrompt({
    prompt: [
      'all=$ARGUMENTS',
      'first=$0',
      'second=$ARGUMENTS[1]',
      'missing=$8',
      'escaped=\\$0',
      'root=${CLAUDE_PLUGIN_ROOT}',
    ].join('\n'),
    commandArgs: args,
    pluginRoot: '/plugins/example',
  })

  assert.equal(expanded, [
    'all="hello world" second $0',
    'first=hello world',
    'second=second',
    'missing=$8',
    'escaped=$0',
    'root=/plugins/example',
  ].join('\n'))
})

test('Markdown parsing strips frontmatter, normalizes CRLF, and rejects an incomplete oversized body', () => {
  const parsed = parseSlashCommandMarkdown({
    raw: '---\r\ndescription: Run the observable workflow\r\n---\r\nLine one\r\nLine two\r\n',
    command: '/observable',
    sourcePath: '/repo/.claude/commands/observable.md',
    pluginRoot: '/plugin/root',
  })

  assert.equal(parsed.description, 'Run the observable workflow')
  assert.equal(parsed.prompt, 'Line one\nLine two')
  assert.equal(parsed.sourcePath, '/repo/.claude/commands/observable.md')
  assert.equal(parsed.pluginRoot, '/plugin/root')
  assert.throws(
    () => parseSlashCommandMarkdown({
      raw: 'x'.repeat(MAX_SLASH_COMMAND_PROMPT_CHARS + 1),
      command: '/oversized',
    }),
    /exceeds/,
  )
})

test('serial runner coalesces concurrent work but always executes the latest request', async () => {
  let releaseFirst: (() => void) | undefined
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const seen: string[] = []
  const runner = new LatestSerialRunner<string>(async (value) => {
    seen.push(value)
    if (value === 'first') await firstBlocked
  })

  const first = runner.run('first')
  const second = runner.run('second')
  const latest = runner.run('latest')
  assert.equal(first, second)
  assert.equal(second, latest)
  assert.deepEqual(seen, ['first'])

  releaseFirst?.()
  await latest
  assert.deepEqual(seen, ['first', 'latest'])
})

test('serial runner cannot strand a request in the drain completion microtask', async () => {
  let releaseFirst: (() => void) | undefined
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const seen: string[] = []
  const runner = new LatestSerialRunner<string>(async (value) => {
    seen.push(value)
    if (value === 'first') await firstBlocked
  })

  const first = runner.run('first')
  releaseFirst?.()
  let late: Promise<void> | undefined
  queueMicrotask(() => {
    late = runner.run('late')
  })

  await first
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  assert.ok(late)
  await late
  assert.deepEqual(seen, ['first', 'late'])
})

// --- honest catalogue (2026-08-30) ------------------------------------------
// We advertised sixteen builtins lifted from Claude Code's own terminal menu, none implemented, each
// handed to the model as a one-line label with an instruction not to defer to the terminal. Measured
// against what a session can actually do: 3 worked, 7 produced a confident answer that was not the
// command, 4 could not work at all, and 2 were hazards. They also occupy picker positions 0 to 15, so
// they were the first sixteen things a user saw.
//
// Anthropic's Telegram channel advertises three chat commands and implements all three. That is the
// rule these tests pin: advertise only what we can perform, and give whatever stays a real procedure
// instead of a noun.

test('the commands that cannot work are no longer advertised', () => {
  const names = BUILTIN_COMMANDS.map((c) => c.command)
  for (const gone of ['/clear', '/cost', '/release-notes', '/login']) {
    assert.ok(
      !names.includes(gone),
      `${gone} must not be advertised: no mechanism exists for a session to perform it over chat`,
    )
  }
})

test('the two hazards are no longer advertised', () => {
  const names = BUILTIN_COMMANDS.map((c) => c.command)
  // /logout was offered to a phone, at picker position 15, on every paired agent. A model with shell
  // access, told to execute and forbidden from deferring to the terminal, has an obvious literal move
  // that ends the session and daemon serving the chat. /bug could file a real public issue.
  assert.ok(!names.includes('/logout'), '/logout could end the very daemon serving the chat')
  assert.ok(!names.includes('/bug'), '/bug could file a real public issue on a stray tap')
})

test('the commands we keep are ones a session can actually perform', () => {
  const names = BUILTIN_COMMANDS.map((c) => c.command)
  for (const kept of ['/help', '/memory', '/init', '/status', '/model', '/mcp']) {
    assert.ok(names.includes(kept), `${kept} must stay: it is answerable`)
  }
})

test('every advertised builtin carries a procedure, not just a label', () => {
  // The distinction that separates Anthropic's terminal skills (which work) from our builtins (which
  // did not) is not code versus prompt. Their skill hands the model eight numbered steps; ours handed
  // it a noun. Anything advertised must now say what to do.
  for (const entry of BUILTIN_COMMANDS) {
    assert.ok(
      typeof entry.prompt === 'string' && entry.prompt.trim().length > 0,
      `${entry.command} must carry a prompt body describing what to actually do`,
    )
  }
})

test('an imitation command must admit what it could not change', () => {
  // The trust problem was never that a command failed. It was that a confident answer and a wrong one
  // looked identical. Anything we cannot really perform has to say so in its own answer.
  const imitations = ['/model', '/mcp', '/agents', '/permissions', '/hooks', '/doctor']
  for (const name of imitations) {
    const entry = BUILTIN_COMMANDS.find((c) => c.command === name)
    assert.ok(entry, `${name} should still be advertised`)
    assert.match(
      String(entry?.prompt),
      /cannot|could not|unable|not able/i,
      `${name} must instruct the reply to state plainly what it could not do`,
    )
  }
})

test('the catalogue is short enough to be learnable', () => {
  assert.ok(
    BUILTIN_COMMANDS.length <= 10,
    `advertising ${BUILTIN_COMMANDS.length} builtins is back toward the wall of options this fix removed`,
  )
})

test('prompt bodies stay local and never reach the backend catalog', () => {
  // Giving the survivors a real procedure added ~3.3 KB of instruction text. That text is for the
  // model on THIS machine; it must not be uploaded. The backend also caps a description at 100
  // characters, so a long body arriving in the wrong field would 400 the whole sync and leave the
  // agent with no catalog at all.
  const { wireCommands } = prepareSlashCommands(BUILTIN_COMMANDS)
  assert.ok(wireCommands.length > 0, 'sanity: the catalog is not empty')
  for (const entry of wireCommands) {
    assert.ok(!('prompt' in entry), `${entry.command} leaked its prompt body onto the wire`)
  }
  // The cap assertion that used to sit in this loop was removed: it read the length of a WIRE
  // description, which prepareSlashCommands had already sliced, so it was true by construction and
  // stayed green when the slice was deleted. The real guard is the truncation test below, which
  // feeds a description long enough that the cap has to do something.
})


// --- the three things the adversarial pass found in this file ---------------

test('an oversized description is truncated to the backend cap before the wire', () => {
  // This is the guard the removed loop line was meant to be. The backend caps a description at 100
  // characters and 400s a sync that exceeds it, which would leave the agent with no catalog at all.
  const long = 'Q'.repeat(3300)
  const { wireCommands } = prepareSlashCommands([
    { command: '/help', description: long, scope: 'all', prompt: 'x' },
  ])
  assert.equal(wireCommands[0]!.description.length, MAX_SLASH_COMMAND_DESCRIPTION_LENGTH)
  assert.equal(wireCommands[0]!.description, long.slice(0, MAX_SLASH_COMMAND_DESCRIPTION_LENGTH))
})

test('/help carries the real catalog, so the model is not asked to list commands it cannot see', () => {
  // The dispatch tells the model which command the user picked and nothing else. /help was asking it
  // to "list the other slash commands available", which it had never been shown, so it answered with
  // itself or with plausible inventions. Neither is a help screen.
  const { registry, legacyAliases } = prepareSlashCommands([
    { command: '/help', description: 'What this agent can do here', scope: 'all', prompt: 'List them.' },
    { command: '/pair', description: 'Pair this machine', scope: 'all', prompt: 'p' },
    { command: '/hoai:deploy', description: 'Ship it', scope: 'all', prompt: 'd' },
  ])
  const delivery = buildSlashCommandDelivery({
    commandName: 'help',
    commandArgs: '',
    registry,
    legacyAliases,
  })

  assert.match(delivery.content, /<available_commands>/)
  const block = delivery.content.slice(
    delivery.content.indexOf('<available_commands>'),
    delivery.content.indexOf('</available_commands>'),
  )
  assert.ok(block.includes('Pair this machine'), 'each line carries its description')
  // The registry KEY is what the picker shows, so that is what gets rendered. Rendering the raw
  // entry.command would hand the user a name they cannot find.
  for (const key of registry.keys()) {
    assert.ok(block.includes(`/${key}`), `/${key} is a registry key and must appear`)
  }
})

test('a command NOT in the registry never appears in the /help catalog', () => {
  // The other half: the block must be the registry, not a wish list. A command dropped by a
  // collision or by the cap must not be advertised, because the picker will not offer it.
  const { registry, legacyAliases } = prepareSlashCommands([
    { command: '/help', description: 'h', scope: 'all', prompt: 'List them.' },
  ])
  const delivery = buildSlashCommandDelivery({
    commandName: 'help',
    commandArgs: '',
    registry,
    legacyAliases,
  })
  assert.equal(delivery.content.includes('/pair'), false)
})

test('a command that is not /help gets no catalog block', () => {
  // The block is a real cost in every dispatch, so it goes only where it is the answer.
  const { registry, legacyAliases } = prepareSlashCommands([
    { command: '/help', description: 'h', scope: 'all', prompt: 'h' },
    { command: '/status', description: 's', scope: 'all', prompt: 's' },
  ])
  const delivery = buildSlashCommandDelivery({
    commandName: 'status',
    commandArgs: '',
    registry,
    legacyAliases,
  })
  assert.equal(delivery.content.includes('<available_commands>'), false)
})

test('every builtin description names only what its own procedure asks for', () => {
  // /status shipped saying "Version, pairing and update state" while its procedure asked for name,
  // id, version and working directory. The description is what the picker shows and what the
  // dispatch quotes back as "Registered behavior", so a description promising more than the
  // procedure delivers is a promise the model then has to improvise around.
  const NOUNS: Array<{ noun: RegExp; inPrompt: RegExp; label: string }> = [
    { noun: /pairing/i, inPrompt: /pair/i, label: 'pairing' },
    { noun: /\bupdate\b/i, inPrompt: /update/i, label: 'update' },
    // 'project memory' in Claude Code IS CLAUDE.md, so naming the file counts as asking for it.
    // The guard is about a description promising a capability the procedure never performs, not
    // about vocabulary matching.
    { noun: /memor/i, inPrompt: /memor|CLAUDE\.md/i, label: 'memory' },
    { noun: /\bcost\b/i, inPrompt: /cost|token|spend/i, label: 'cost' },
  ]
  for (const entry of BUILTIN_COMMANDS) {
    const prompt = entry.prompt ?? ''
    for (const { noun, inPrompt, label } of NOUNS) {
      if (!noun.test(entry.description)) continue
      assert.ok(
        inPrompt.test(prompt),
        `${entry.command} advertises "${label}" but its procedure never asks for it: ${entry.description}`,
      )
    }
  }
})
