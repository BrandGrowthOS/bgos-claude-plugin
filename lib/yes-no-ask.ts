/**
 * A yes or no question to the owner is always two buttons to tap.
 *
 * An agent that writes "Should I go ahead?" in a plain reply leaves its owner
 * to type the answer. This file holds the one sentence that tells the agent to
 * ask such a question as an ask_user_input card with two options, and the
 * cheap way to do it from `reply`: `yes_no: true` with the question as `text`.
 *
 * The shorthand makes nothing new. The dispatcher in server.ts turns that
 * reply into the ask_user_input call this file builds (one question, the
 * options Yes and No with the values yes and no, wait_seconds 0), so the owner
 * gets the same card and the agent the same pending result and the same
 * ask_answered event as if it had called ask_user_input itself. Nothing reads
 * a question out of a reply's words: without `yes_no: true` a reply is a
 * reply.
 *
 * The app draws a question whose two options are yes and no as two buttons
 * side by side; it reads the VALUES, so an agent may put two words of its own
 * on the buttons (Deploy now, Not yet) and keep the values yes and no.
 *
 * Only in the agent's own chat with its owner. An ask's answer names nobody,
 * so in a group or a channel any member could tap it and the agent would hear
 * that its owner answered; reply buttons name who tapped. A meeting takes
 * text only, and a peer side thread is read by another agent. routeYesNoReply
 * refuses the shorthand in all three, and in a session that does not hold the
 * agent's connection, where the tap could never come back, before anything is
 * posted.
 *
 * No em or en dashes anywhere in this file: its sentences are injected into
 * prompts.
 */

/** The rule, word for word, in the tool descriptions, the instructions and the offline guide. */
export const YES_NO_RULE =
  'In your own chat with your owner, a question your owner answers yes or no, except a dangerous ' +
  'command, which stays on the approval, always goes through ask_user_input as one question with two ' +
  'options, Yes and No (or two short words of your own), with the values yes and no, never as a ' +
  'question in plain text: the app draws it as two buttons to tap. In a group or a channel, ask with ' +
  'reply buttons instead.'

/** The reply tool's cheap way to send that card. */
export const REPLY_YES_NO_SHORTHAND =
  'From reply, yes_no: true with the question as text sends exactly that card and returns as ' +
  'ask_user_input does with wait_seconds 0.'

/** The two options the shorthand puts on the card, in this order. */
export const YES_NO_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'Yes', value: 'yes' },
  { label: 'No', value: 'no' },
]

/** What a reply carries that a question card cannot, and the word for it in a refusal. */
const NOT_ON_A_CARD: ReadonlyArray<[key: string, words: string]> = [
  ['files', 'files'],
  ['buttons', 'buttons'],
  ['reply_to_id', 'a quoted reply (reply_to_id)'],
]

export interface YesNoAskArgs {
  chat_id: unknown
  questions: Array<{ text: string; options: Array<{ label: string; value: string }> }>
  wait_seconds: 0
}

/**
 * The ask_user_input call a reply with `yes_no: true` stands for, an error
 * (nothing is posted) when it cannot be one plain card, or null when the
 * reply did not ask for one.
 */
export function replyYesNoAsk(
  args: Record<string, unknown> | undefined,
): { args: YesNoAskArgs } | { error: string } | null {
  if (!args || args.yes_no === undefined || args.yes_no === false) return null
  if (args.yes_no !== true) {
    return { error: 'Error: yes_no must be true or left out. Nothing was posted.' }
  }
  const text = typeof args.text === 'string' ? args.text.trim() : ''
  if (!text) {
    return { error: 'Error: yes_no needs the question as text. Nothing was posted.' }
  }
  const extra = NOT_ON_A_CARD.filter(([key]) => {
    const value = args[key]
    return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)
  })
  if (extra.length) {
    return {
      error:
        `Error: yes_no sends a question card, which cannot carry ${extra.map(([, words]) => words).join(' or ')}. ` +
        'Send those in their own reply first, then the question. Nothing was posted.',
    }
  }
  return {
    args: {
      chat_id: args.chat_id,
      questions: [{ text, options: YES_NO_OPTIONS.map((o) => ({ ...o })) }],
      wait_seconds: 0,
    },
  }
}

/** A chat where a yes or no card is refused: anything but the agent's own chat with its owner. */
export type YesNoRefusedKind = 'group' | 'meeting' | 'side_thread'

/** Anything that says whether it holds a chat id: a Set, a Map, a refused chats list. */
export interface HoldsChats {
  has(chatId: string): boolean
}

/** The daemon's own records of each kind of chat that is not the owner's own chat. */
export interface YesNoChatRecords {
  groups: readonly HoldsChats[]
  meetings: readonly HoldsChats[]
  sideThreads: readonly HoldsChats[]
}

/** The kind of a chat a yes or no card is refused in, or null (the owner's own chat, or one no record holds). */
export function yesNoRefusedKind(chatId: string, records: YesNoChatRecords): YesNoRefusedKind | null {
  const held = (list: readonly HoldsChats[]) => list.some((record) => record.has(chatId))
  if (held(records.meetings)) return 'meeting'
  if (held(records.sideThreads)) return 'side_thread'
  if (held(records.groups)) return 'group'
  return null
}

/** One plain sentence back to the agent for each refused kind; nothing was posted. */
export const YES_NO_REFUSED: Readonly<Record<YesNoRefusedKind, string>> = {
  group:
    'Error: nothing was posted, because yes_no is only for your own chat with your owner and in a group ' +
    'or a channel anyone could tap the answer, so ask with reply buttons there instead.',
  meeting:
    'Error: nothing was posted, because yes_no is only for your own chat with your owner and a meeting ' +
    'takes text only, so ask the question in words there instead.',
  side_thread:
    'Error: nothing was posted, because yes_no is only for your own chat with your owner and a side ' +
    'thread is read by another agent, so ask in words there instead.',
}

/** A session that does not hold the agent's connection never hears the tap. */
export const YES_NO_PASSIVE_REFUSAL =
  'Error: nothing was posted, because this session is not the one connected to BGOS for this agent, ' +
  'so the tap on a yes_no card could never come back here; ask from the connected session.'

export interface YesNoRouteFacts {
  /** This daemon holds the agent's connection, so a card's answer comes back here. */
  connected: boolean
  /** The refused kind of the chat a chat_id names, or null; an unknown chat is left to the card's own check. */
  refusedKind: (chatId: unknown) => YesNoRefusedKind | null
}

/**
 * The dispatcher's one door for the shorthand. Any call but a reply with
 * `yes_no: true` comes back as it came. That reply comes back as the
 * ask_user_input call replyYesNoAsk builds, or as one refusal: first a call
 * that cannot be one plain card, then a session that does not hold the
 * connection, then a chat that is not the owner's own.
 */
export function routeYesNoReply<P extends { name: string; arguments?: Record<string, unknown> }>(
  params: P,
  facts: YesNoRouteFacts,
): { params: P } | { refusal: string } {
  if (params.name !== 'reply') return { params }
  const made = replyYesNoAsk(params.arguments)
  if (made === null) return { params }
  if ('error' in made) return { refusal: made.error }
  if (!facts.connected) return { refusal: YES_NO_PASSIVE_REFUSAL }
  const kind = facts.refusedKind(made.args.chat_id)
  if (kind) return { refusal: YES_NO_REFUSED[kind] }
  return { params: { ...params, name: 'ask_user_input', arguments: made.args as unknown as Record<string, unknown> } }
}
