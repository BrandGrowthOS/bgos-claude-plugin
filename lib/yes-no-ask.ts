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
 * No em or en dashes anywhere in this file: its sentences are injected into
 * prompts.
 */

/** The rule, word for word, in the tool descriptions, the instructions and the offline guide. */
export const YES_NO_RULE =
  'A question your owner answers yes or no always goes through ask_user_input as one question with ' +
  'two options, Yes and No (or two short words of your own), with the values yes and no, never as a ' +
  'question in plain text: the app draws it as two buttons to tap.'

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
