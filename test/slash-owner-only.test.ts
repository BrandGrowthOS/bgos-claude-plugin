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
 * No em or en dashes in this file.
 */

import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BUILTIN_COMMANDS,
  prepareSlashCommands,
  routeSlashCommand,
  type SlashCommandEntry,
} from '../lib/slash-catalog.ts'

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

test('a project command that shadows /permissions is the owner\'s own and is not rewritten', () => {
  const shadow: SlashCommandEntry = { command: '/permissions', description: 'mine', scope: 'all', prompt: 'OWNER PROJECT BODY' }
  const reg = prepareSlashCommands([shadow])
  const route = routeSlashCommand({
    payload: slash('/permissions', NON_OWNERS[0]!.sender),
    registry: reg.registry,
    speaker: { ownerUserId: OWNER, fromHuman: true },
  })
  assert.equal(route.kind, 'directive')
  if (route.kind === 'directive') assert.match(route.delivery.content, /OWNER PROJECT BODY/)
})

test('the wire catalog never carries a non owner answer', () => {
  for (const entry of prepared.wireCommands) {
    assert.deepEqual(Object.keys(entry).sort(), ['command', 'description', 'scope'])
  }
})

// ── Production wiring: all three main-session rails name the speaker ────────
const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

test('every routeSlashCommand call in server.ts names the speaker with the owner id', () => {
  const calls = [...serverSource.matchAll(/routeSlashCommand\(\{([\s\S]*?)\n\s*\}\)/g)]
  assert.equal(calls.length, 3, 'poll, stream and socket')
  for (const [, body] of calls) {
    assert.match(body!, /speaker: \{ ownerUserId: USER_ID, fromHuman: \w+ \}/)
  }
})

test('each rail computes fromHuman from the same signals its sign-in code gate reads', () => {
  assert.match(serverSource, /const pollFromHuman = !isPollAgent && pollSenderType !== 'system'\n/)
  assert.match(serverSource, /const wsFromHuman = !wsAgentOrigin && !wsRoomAgent && wsSenderType !== 'agent' && wsSenderType !== 'system'\n/)
  assert.match(serverSource, /const streamFromHuman = !isSystem && !view\.agentOrigin && view\.senderKind === 'user'\n/)
})
