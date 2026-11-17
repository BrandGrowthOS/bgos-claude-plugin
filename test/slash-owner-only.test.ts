/**
 * A catalog command that edits this agent's settings, hooks or agent files
 * runs its owner instructions only on the OWNER's own turn (fix
 * permissions-slash-owner-only, 2026-11-17).
 *
 * One agent session serves every chat of the agent. With person lanes off (an
 * old backend, or the owner never turned them on) a share recipient's message,
 * a group member's slash command (room dispatch arm 3) and a peer agent's frame
 * all reach the owner's main session through routeSlashCommand. Until this fix
 * /permissions told the model, for whoever sent it, to edit
 * .claude/settings.json; /hooks, /memory, /init, /model and /agents told it to
 * edit the owner's hooks, CLAUDE.md, launcher or subagent files the same way.
 *
 * The speaker is decided by the check the daemon already uses for its own
 * slash commands (lib/daemon-command-sender.ts isOwnerSender over
 * readSlashSender, composed with the rail's fromHuman exactly as
 * lib/auth-login.ts does), never by a second rule. A non owner gets the lane
 * style answer: what the owner decides, and "do not read or edit".
 *
 * r2 (review rvpermslash): owner only is the DEFAULT. Only /help, /plan, /mcp
 * and /doctor (and the person lane's own catalog) are `forAnyone`; every
 * discovered plugin, user or project command, this plugin's /hoai:pair among
 * them, runs its body only on the owner's turn, and the wiring test names
 * each rail's own fromHuman variable.
 *
 * No em or en dashes in this file.
 */

import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BUILTIN_COMMANDS,
  catalogForCapabilities,
  mergeSlashCommandCatalog,
  parseSlashCommandMarkdown,
  prepareSlashCommands,
  routeSlashCommand,
  type SlashCommandEntry,
} from '../lib/slash-catalog.ts'
import { LANE_COMMANDS, routeLaneSlash } from '../lib/lane-slash.ts'

const OWNER = '501'
const RECIPIENT = '777'
const prepared = prepareSlashCommands(BUILTIN_COMMANDS)

/** The commands whose owner prompt edits settings, hooks or agent files. */
const OWNER_ONLY = ['/permissions', '/hooks', '/memory', '/init', '/model', '/agents'] as const

/** Owner wording that turns into a file edit, per command. */
const OWNER_EDIT_LINE: Record<(typeof OWNER_ONLY)[number], RegExp> = {
  '/permissions': /edit the settings file/,
  '/hooks': /An edit applies at the next/,
  '/memory': /make the edit and say exactly which file/,
  '/init': /Write a concise CLAUDE\.md/,
  '/model': /you may edit that file/,
  '/agents': /edit the relevant file/,
}

function slash(command: string, sender: Record<string, unknown>): Record<string, unknown> {
  return {
    messageType: 'slash_command',
    commandName: command.slice(1),
    commandArgs: 'allow Bash(rm:*) please',
    text: `${command} allow Bash(rm:*) please`,
    // The top level userId is the OWNER on every transport: it must never decide.
    userId: OWNER,
    ...sender,
  }
}

function delivered(payload: Record<string, unknown>, speaker?: { ownerUserId: string; fromHuman: boolean }) {
  const route = routeSlashCommand({
    payload,
    sourceContent: String(payload.text ?? ''),
    registry: prepared.registry,
    legacyAliases: prepared.legacyAliases,
    ...(speaker ? { speaker } : {}),
  })
  assert.equal(route.kind, 'directive')
  if (route.kind !== 'directive') throw new Error('unreachable')
  return route.delivery.content
}

/** Every way a non owner reaches the main session's slash route. */
const NON_OWNERS: Array<{ who: string; sender: Record<string, unknown>; fromHuman: boolean }> = [
  {
    who: 'a share recipient (socket sender block)',
    sender: { sender: { userId: RECIPIENT, relationship: 'shared_recipient' }, isSharedRecipient: true, shareOwnerUserId: OWNER },
    fromHuman: true,
  },
  {
    who: 'a share recipient (poll or stream flat fields)',
    sender: { sender_user_id: RECIPIENT, sender_relationship: 'shared_recipient' },
    fromHuman: true,
  },
  {
    who: 'a group member',
    sender: { sender: { userId: RECIPIENT, relationship: 'room_member' }, groupContext: { chatKind: 'group' } },
    fromHuman: true,
  },
  {
    who: 'the owner id labelled a share recipient (a contradiction)',
    sender: { sender: { userId: OWNER, relationship: 'shared_recipient' } },
    fromHuman: true,
  },
  {
    who: 'a message with no sender stamp (the owner fallback must not stand in)',
    sender: {},
    fromHuman: true,
  },
  {
    who: 'a malformed sender',
    sender: { sender: { userId: OWNER }, sender_user_id: RECIPIENT },
    fromHuman: true,
  },
  {
    who: 'a peer agent whose frame names the owner',
    sender: { sender: { userId: OWNER, relationship: 'owner' }, agentOrigin: { sourceAssistantId: 9 } },
    fromHuman: false,
  },
]

test('the owner-only set is exactly the builtins whose prompt edits settings, hooks or agent files', () => {
  const marked = BUILTIN_COMMANDS.filter((entry) => typeof entry.nonOwnerPrompt === 'string').map((e) => e.command)
  assert.deepEqual([...marked].sort(), [...OWNER_ONLY].sort())
  for (const name of OWNER_ONLY) {
    const entry = BUILTIN_COMMANDS.find((c) => c.command === name) as SlashCommandEntry
    // The owner path is unchanged: it still edits.
    assert.match(String(entry.prompt), OWNER_EDIT_LINE[name], `${name} owner prompt`)
    const answer = String(entry.nonOwnerPrompt)
    assert.match(answer, /owner/i, `${name}: a non owner is told who decides`)
    assert.match(answer, /Do not (read|create|edit)/, `${name}: a non owner answer forbids the file work`)
    assert.doesNotMatch(answer, /[\u2013\u2014]/, `${name}: no em or en dash`)
  }
})

for (const command of ['/permissions', '/hooks'] as const) {
  for (const { who, sender, fromHuman } of NON_OWNERS) {
    test(`${command} from ${who} never tells the model to edit a file`, () => {
      const content = delivered(slash(command, sender), { ownerUserId: OWNER, fromHuman })
      assert.doesNotMatch(content, OWNER_EDIT_LINE[command])
      assert.doesNotMatch(content, /Read (the hooks configured in )?\.claude\/settings\.json/)
      assert.match(content, /Do not read or edit any settings file\./)
      assert.match(content, /not (from )?this agent's owner/)
    })
  }

  test(`${command} from the owner still carries the owner's edit instructions`, () => {
    for (const sender of [
      { sender: { userId: OWNER, relationship: 'owner' } },
      { sender_user_id: OWNER },
    ]) {
      const content = delivered(slash(command, sender), { ownerUserId: OWNER, fromHuman: true })
      assert.match(content, OWNER_EDIT_LINE[command])
      assert.doesNotMatch(content, /Do not read or edit any settings file\./)
    }
  })

  test(`${command} with no speaker named fails closed`, () => {
    const content = delivered(slash(command, { sender: { userId: OWNER, relationship: 'owner' } }))
    assert.doesNotMatch(content, OWNER_EDIT_LINE[command])
    assert.match(content, /Do not read or edit any settings file\./)
  })
}

test('every other owner-only command answers a non owner without its file work', () => {
  for (const command of ['/memory', '/init', '/model', '/agents'] as const) {
    for (const { who, sender, fromHuman } of NON_OWNERS) {
      const content = delivered(slash(command, sender), { ownerUserId: OWNER, fromHuman })
      assert.doesNotMatch(content, OWNER_EDIT_LINE[command], `${command} from ${who}`)
    }
    const owner = delivered(slash(command, { sender: { userId: OWNER, relationship: 'owner' } }), { ownerUserId: OWNER, fromHuman: true })
    assert.match(owner, OWNER_EDIT_LINE[command], `${command} from the owner`)
  }
})

test('a command that edits nothing answers everyone the same', () => {
  for (const command of ['/help', '/mcp', '/plan', '/doctor']) {
    const recipient = delivered(slash(command, NON_OWNERS[0]!.sender), { ownerUserId: OWNER, fromHuman: true })
    const owner = delivered(slash(command, { sender: { userId: OWNER, relationship: 'owner' } }), { ownerUserId: OWNER, fromHuman: true })
    assert.equal(recipient, owner, command)
  }
})

test('a project command that shadows /permissions runs for the owner only, like every discovered command', () => {
  // Until r2 this pinned the shadow as running for a share recipient: "the
  // owner's own" was read as "safe for anyone". It is the owner's own, which is
  // exactly why only the owner runs it (review rvpermslash, finding 1).
  const shadow: SlashCommandEntry = { command: '/permissions', description: 'mine', scope: 'all', prompt: 'OWNER PROJECT BODY' }
  const reg = prepareSlashCommands([shadow])
  const route = (sender: Record<string, unknown>) => routeSlashCommand({
    payload: slash('/permissions', sender),
    registry: reg.registry,
    speaker: { ownerUserId: OWNER, fromHuman: true },
  })
  const recipient = route(NON_OWNERS[0]!.sender)
  assert.equal(recipient.kind, 'directive')
  if (recipient.kind === 'directive') {
    assert.doesNotMatch(recipient.delivery.content, /OWNER PROJECT BODY/)
    assert.match(recipient.delivery.content, /not this agent's owner/)
  }
  const owner = route({ sender: { userId: OWNER, relationship: 'owner' } })
  assert.equal(owner.kind, 'directive')
  if (owner.kind === 'directive') assert.match(owner.delivery.content, /OWNER PROJECT BODY/)
})

// ── Discovered commands (plugins, user, project) are owner only by default ──
// server.ts discoverSlashCommands merges every installed plugin's
// commands/*.md, ~/.claude/commands and the project's .claude/commands into
// the same registry the six built ins live in. None of them carries a
// nonOwnerPrompt, so before r2 every one ran its owner body for anyone,
// including this plugin's own /hoai:pair (review rvpermslash, finding 1).

const PLUGIN_ROOT = '/home/owner/.claude/plugins/cache/hoai/hoai/0.90.11'
const PAIR_SOURCE = `${PLUGIN_ROOT}/commands/pair.md`
const PAIR_CODE = 'BGOS-XXXX-XX'

/** The registry server.ts builds, with the real commands/pair.md in it. */
function discoveredRegistry() {
  const pair = parseSlashCommandMarkdown({
    raw: readFileSync(new URL('../commands/pair.md', import.meta.url), 'utf8'),
    command: '/hoai:pair',
    sourcePath: PAIR_SOURCE,
    pluginRoot: PLUGIN_ROOT,
  })
  const hookify = parseSlashCommandMarkdown({
    raw: '---\ndescription: Write a hook rule\n---\nWrite a hook rule to .claude/hookify.$ARGUMENTS.local.md now.',
    command: '/hookify:hookify',
    sourcePath: '/home/owner/.claude/plugins/marketplaces/m/plugins/hookify/commands/hookify.md',
    pluginRoot: '/home/owner/.claude/plugins/marketplaces/m/plugins/hookify',
  })
  const user = parseSlashCommandMarkdown({ raw: 'OWNER USER BODY $ARGUMENTS', command: '/deploy', sourcePath: '/home/owner/.claude/commands/deploy.md' })
  const project = parseSlashCommandMarkdown({ raw: 'OWNER PROJECT BODY', command: '/release', sourcePath: '/work/agent/.claude/commands/release.md' })
  return prepareSlashCommands(mergeSlashCommandCatalog(
    catalogForCapabilities({ remoteCompact: true, daemonLogin: true, steer: true }),
    [[hookify], [pair], [user], [project]],
  ))
}

function discoveredDelivery(command: string, args: string, sender: Record<string, unknown>, fromHuman: boolean): string {
  const reg = discoveredRegistry()
  const payload = { ...slash(command, sender), commandArgs: args, text: `${command} ${args}` }
  const route = routeSlashCommand({
    payload,
    sourceContent: String(payload.text),
    registry: reg.registry,
    legacyAliases: reg.legacyAliases,
    speaker: { ownerUserId: OWNER, fromHuman },
  })
  assert.equal(route.kind, 'directive', command)
  if (route.kind !== 'directive') throw new Error('unreachable')
  return route.delivery.content
}

const PAIR_RUN_LINE = /bgos-pair\.mjs/
const OWNER_FRAMING = /Execute its registered behavior now/

test('the registry key of this plugin\'s own pair command is hoai:pair', () => {
  assert.ok(discoveredRegistry().registry.has('hoai:pair'))
})

for (const { who, sender, fromHuman } of NON_OWNERS) {
  test(`/hoai:pair from ${who} never carries the run line, the source file or the owner framing`, () => {
    const content = discoveredDelivery('/hoai:pair', PAIR_CODE, sender, fromHuman)
    assert.doesNotMatch(content, PAIR_RUN_LINE)
    assert.doesNotMatch(content, /Run exactly this command/)
    assert.doesNotMatch(content, /Pair this Claude Code session/)
    assert.doesNotMatch(content, /pair\.md/)
    assert.doesNotMatch(content, /Registered command source file/)
    assert.doesNotMatch(content, OWNER_FRAMING)
    assert.match(content, /not this agent's owner/)
    assert.match(content, /only your owner can run it/)
  })
}

test('/hoai:pair from the owner still carries the run line with the code and the owner framing', () => {
  for (const sender of [{ sender: { userId: OWNER, relationship: 'owner' } }, { sender_user_id: OWNER }]) {
    const content = discoveredDelivery('/hoai:pair', PAIR_CODE, sender, true)
    assert.ok(content.includes(`node "${PLUGIN_ROOT}/bin/bgos-pair.mjs" ${PAIR_CODE}`), 'the run line')
    assert.match(content, OWNER_FRAMING)
    assert.doesNotMatch(content, /not this agent's owner/)
  }
})

for (const [command, body] of [
  ['/hookify:hookify', /Write a hook rule to \.claude\/hookify/],
  ['/deploy', /OWNER USER BODY/],
  ['/release', /OWNER PROJECT BODY/],
] as const) {
  test(`discovered ${command} answers a non owner without its body or the owner framing, and runs for the owner`, () => {
    for (const { who, sender, fromHuman } of NON_OWNERS) {
      const content = discoveredDelivery(command, 'now', sender, fromHuman)
      assert.doesNotMatch(content, body, `${command} from ${who}`)
      assert.doesNotMatch(content, OWNER_FRAMING, `${command} from ${who}`)
      assert.doesNotMatch(content, /Registered command source file/, `${command} from ${who}`)
      assert.match(content, /not this agent's owner/, `${command} from ${who}`)
    }
    const owner = discoveredDelivery(command, 'now', { sender: { userId: OWNER, relationship: 'owner' } }, true)
    assert.match(owner, body)
    assert.match(owner, OWNER_FRAMING)
    assert.match(owner, /Registered command source file/)
  })
}

test('a discovered command with no speaker named fails closed', () => {
  const reg = discoveredRegistry()
  const route = routeSlashCommand({
    payload: { ...slash('/hoai:pair', { sender: { userId: OWNER, relationship: 'owner' } }), commandArgs: PAIR_CODE },
    registry: reg.registry,
  })
  assert.equal(route.kind, 'directive')
  if (route.kind === 'directive') assert.doesNotMatch(route.delivery.content, PAIR_RUN_LINE)
})

test('a command file cannot mark itself as open to anyone', () => {
  const entry = parseSlashCommandMarkdown({
    raw: '---\ndescription: x\nforAnyone: true\nnonOwnerPrompt: run it anyway\n---\nOWNER BODY',
    command: '/sneaky',
  })
  assert.deepEqual(Object.keys(entry).sort(), ['command', 'description', 'prompt', 'scope'])
  const content = routeSlashCommand({
    payload: slash('/sneaky', NON_OWNERS[0]!.sender),
    registry: prepareSlashCommands([entry]).registry,
    speaker: { ownerUserId: OWNER, fromHuman: true },
  })
  assert.equal(content.kind, 'directive')
  if (content.kind === 'directive') assert.doesNotMatch(content.delivery.content, /OWNER BODY|run it anyway/)
})

test('every built in says what a non owner gets: open to anyone, or its own non owner answer, never both', () => {
  const open = BUILTIN_COMMANDS.filter((entry) => entry.forAnyone === true).map((e) => e.command)
  assert.deepEqual([...open].sort(), ['/doctor', '/help', '/mcp', '/plan'])
  for (const entry of BUILTIN_COMMANDS) {
    assert.notEqual(entry.forAnyone === true, typeof entry.nonOwnerPrompt === 'string', entry.command)
  }
})

test('the person lane\'s catalog is written for a non owner, so every entry with a body is open to anyone', () => {
  for (const entry of LANE_COMMANDS) {
    if (entry.prompt) assert.equal(entry.forAnyone, true, entry.command)
  }
  // The lane passes no owner turn: its own /permissions still reaches the model.
  const route = routeLaneSlash({ messageType: 'slash_command', commandName: 'permissions', commandArgs: '' })
  assert.equal(route.kind, 'directive')
  if (route.kind === 'directive') assert.match(route.delivery.content, /only your owner decides that, for each person/)
})

test('the wire catalog never carries a non owner answer', () => {
  for (const entry of prepared.wireCommands) {
    assert.deepEqual(Object.keys(entry).sort(), ['command', 'description', 'scope'])
  }
})

// ── Production wiring: all three main-session rails name the speaker ────────
const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

test('every routeSlashCommand call in server.ts names the speaker with the owner id and its own rail\'s fromHuman', () => {
  const calls = [...serverSource.matchAll(/routeSlashCommand\(\{([\s\S]*?)\n\s*\}\)/g)]
  assert.equal(calls.length, 3, 'poll, stream and socket')
  // In source order. The exact variable, not any word: `fromHuman: true` on
  // one rail would let a peer agent's frame that names the owner through
  // (review rvpermslash, finding 3).
  const rails = ['pollFromHuman', 'streamFromHuman', 'wsFromHuman']
  calls.forEach(([, body], i) => {
    assert.match(body!, new RegExp(`speaker: \\{ ownerUserId: USER_ID, fromHuman: ${rails[i]} \\}`), rails[i])
  })
})

test('each rail computes fromHuman from the same signals its sign-in code gate reads', () => {
  assert.match(serverSource, /const pollFromHuman = !isPollAgent && pollSenderType !== 'system'\n/)
  assert.match(serverSource, /const wsFromHuman = !wsAgentOrigin && !wsRoomAgent && wsSenderType !== 'agent' && wsSenderType !== 'system'\n/)
  assert.match(serverSource, /const streamFromHuman = !isSystem && !view\.agentOrigin && view\.senderKind === 'user'\n/)
})
