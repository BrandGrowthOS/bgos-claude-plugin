/**
 * PERSON LANES, the commands of a person's lane (shared agents Phase 3, P5;
 * design section 6, plugin files row: "a lane catalog: /new handled; the
 * /memory, /model, /permissions and /hooks built ins that tell the model to
 * edit the owner's files are reworded for a lane; and discovery stops reading
 * the owner's ~/.claude/commands for a lane").
 *
 * A lane's commands are THIS list and nothing else. The owner's daemon walks
 * the project, user and plugin command folders (server.ts
 * discoverSlashCommands) and syncs their names; a lane never reads a command
 * folder at all, so the body of an owner's `~/.claude/commands/*.md` can never
 * reach a recipient's turn. A command the lane does not have is answered as
 * unavailable, with no body.
 *
 * Four commands the lane daemon performs itself, never the model:
 *   /new      a new conversation for this person: the lane's session is
 *             repinned and its Claude restarted; the memory folder stays;
 *   /model    `/model <name>` switches to a model on the owner's list for
 *             this agent (K7), `/model default` back to the agent's own;
 *   /effort   the same for the effort level;
 *   /login    signs nothing in: a lane can neither post the sign in link
 *             nor take the code back (the person hears it only through the
 *             fixed notices), so the person is told, in the sentence for the
 *             lane's login mode, which Claude sign in our conversations use
 *             (lib/lane-controls.ts laneLoginNotice). It is not in the lane
 *             catalog: listing it would offer a command that does nothing
 *             here. It arrives anyway, from the owner's picker or typed.
 * `/model` and `/effort` with nothing after them are a question, which the
 * model answers from the facts the daemon hands it.
 *
 * No em or en dashes in this file.
 */
import {
  buildSlashCommandDelivery,
  isSlashCommandPayload,
  prepareSlashCommands,
  type SlashCommandDelivery,
  type SlashCommandEntry,
  type SlashCommandPayload,
} from './slash-catalog.ts'

/** The commands the lane daemon performs itself. */
export const LANE_HANDLED_COMMANDS = Object.freeze(['new', 'model', 'effort', 'login'])

/**
 * The lane's catalog. The three handled commands in it carry no prompt
 * (nothing about them reaches a model; `/login` is handled but not listed);
 * the rest are the owner's built ins reworded for a lane:
 * none of them reads or edits a settings file, a CLAUDE.md or anything
 * outside the lane's working folder.
 */
export const LANE_COMMANDS: readonly SlashCommandEntry[] = Object.freeze([
  {
    command: '/help',
    description: 'What I can do for you here',
    scope: 'all',
    prompt: [
      'List, briefly, what you can do for this person in this chat, from your instructions for this lane:',
      'only what this lane allows.',
      'Then list the commands in <available_commands> below, exactly as written, one line each.',
      'That block is the whole catalog of this chat. Do not add a command that is not in it.',
      'Keep everything OUTSIDE that list to four lines or fewer: this is read on a phone.',
    ].join('\n'),
  },
  {
    command: '/new',
    description: 'Start a new conversation with me (my memory of you stays)',
    scope: 'all',
  },
  {
    command: '/memory',
    description: 'What I remember about you',
    scope: 'all',
    prompt: [
      'Your memory of this person is the memory folder your instructions for this lane name: MEMORY.md is',
      'the index and each memory is its own file there.',
      'Read MEMORY.md and tell the person, in plain terms, what you remember about them.',
      'If they asked for a change, make it in those files only (the note file and its index line together)',
      'and say exactly what you changed.',
      'There is no CLAUDE.md or settings file for you to read or edit here, and nothing outside your working',
      'folder is yours to change.',
    ].join('\n'),
  },
  {
    command: '/model',
    description: 'Which model I use with you, or switch to one my owner allows',
    scope: 'all',
  },
  {
    command: '/effort',
    description: 'Which effort level I use with you, or switch to one my owner allows',
    scope: 'all',
  },
  {
    command: '/permissions',
    description: 'What I am allowed to do in our conversations',
    scope: 'all',
    prompt: [
      'Tell the person plainly what you can do in this lane, from your instructions for this lane, and that',
      'nothing else on your owner\'s computer is open to you.',
      'You CANNOT change what this lane may do: only your owner decides that, for each person, in the app.',
      'Do not read or edit any settings file.',
    ].join('\n'),
  },
  {
    command: '/hooks',
    description: 'The checks that run on what I do',
    scope: 'all',
    prompt: [
      'Tell the person plainly that every action you take in this lane passes your owner\'s safety checks',
      'first, which hold anything touching secrets or other people\'s conversations, and that you cannot see,',
      'add or change those checks from here.',
      'Do not read or edit any settings file.',
    ].join('\n'),
  },
])

const PREPARED = prepareSlashCommands([...LANE_COMMANDS])

/** The lane's registry (wire name to entry), the only one a lane ever resolves against. */
export const LANE_COMMAND_REGISTRY = PREPARED.registry

export type LaneSlashRoute =
  | { kind: 'not_slash' }
  | { kind: 'new'; commandArgs: string }
  | { kind: 'model'; commandArgs: string }
  | { kind: 'effort'; commandArgs: string }
  | { kind: 'login'; commandArgs: string }
  | { kind: 'directive'; delivery: SlashCommandDelivery }

function token(raw: unknown): string {
  return String(raw ?? '').trim().replace(/^\/+/, '').toLowerCase()
}

/**
 * Route one delivery of a person's lane. A `slash_command` message, or a
 * plain message that is exactly `/new`, `/model ...`, `/effort ...` or
 * `/login ...` (the app sends a typed command the picker does not list as
 * plain text), goes to the daemon or to a lane catalog directive; everything
 * else is a turn.
 */
export function routeLaneSlash(payload: SlashCommandPayload & Record<string, unknown>): LaneSlashRoute {
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  const typed = /^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(text)
  let name: string
  let args: string
  if (isSlashCommandPayload(payload)) {
    name = token(payload.commandName ?? payload.command_name) || token(typed?.[1])
    const raw = payload.commandArgs ?? payload.command_args
    args = raw == null ? String(typed?.[2] ?? '') : String(raw)
  } else if (typed && (LANE_HANDLED_COMMANDS as readonly string[]).includes(token(typed[1]))) {
    name = token(typed[1])
    args = String(typed[2] ?? '')
  } else {
    return { kind: 'not_slash' }
  }
  args = args.trim()
  if (name === 'new') return { kind: 'new', commandArgs: args }
  if (name === 'model') return { kind: 'model', commandArgs: args }
  if (name === 'effort') return { kind: 'effort', commandArgs: args }
  if (name === 'login') return { kind: 'login', commandArgs: args }
  return {
    kind: 'directive',
    delivery: buildSlashCommandDelivery({
      commandName: name,
      commandArgs: args,
      sourceContent: text,
      registry: LANE_COMMAND_REGISTRY,
    }),
  }
}

/**
 * The question form of `/model` or `/effort` (nothing after it): a turn for
 * the model, with the facts it cannot see. Every value is a string.
 */
export function laneChoiceQuestion(input: {
  kind: 'model' | 'effort'
  current: string | null
  allowed: readonly string[]
}): { content: string; meta: Record<string, string> } {
  const word = input.kind === 'model' ? 'model' : 'effort level'
  const lines = [
    '[BGOS lane command]',
    `The person asked which ${word} you use with them.`,
    input.current
      ? `You use the ${word} ${JSON.stringify(input.current)}, which they chose.`
      : `You use your agent's own default ${word}.`,
    input.allowed.length > 0
      ? `Your owner allows these for this person: ${input.allowed.map((m) => JSON.stringify(m)).join(', ')}. They can switch with /${input.kind} followed by one of them, or /${input.kind} default.`
      : `Your owner allows no other ${word} for this person, so it cannot be switched.`,
    'Tell them this in one or two plain sentences.',
  ]
  return {
    content: lines.join('\n'),
    meta: {
      event_type: 'slash_command',
      command_name: input.kind,
      command_args: '',
      slash_dispatch: 'lane_question',
    },
  }
}
