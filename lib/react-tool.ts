export const REACT_TOOL = {
  name: 'react',
  description:
    'React to a message with one emoji per message. A new emoji replaces the old one. ' +
    'Use it to acknowledge or agree. In your chat with your owner, when their message needs no words back ' +
    '(thanks, ok, a fact to keep, a done confirmation), react and send nothing else; when you start work longer ' +
    'than a minute, react 👀 at once, then reply with the result. Never react instead of answering a question or ' +
    'reporting a result. Set remove to true to remove that emoji. Requires this agent to be paired.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      message_id: { type: 'string', description: 'The message ID to react to.' },
      emoji: { type: 'string', description: 'The emoji to add or remove, at most 32 characters by the server\'s emoji length rule.' },
      remove: { type: 'boolean', default: false, description: 'Remove this emoji instead of adding it.' },
    },
    required: ['message_id', 'emoji'],
    additionalProperties: false,
  },
}

type ReactToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function failure(text: string): ReactToolResult {
  return { content: [{ type: 'text' as const, text }], isError: true }
}

/** Match the reaction DTO's MaxLength rule, including emoji presentation selectors. */
function emojiLength(emoji: string): number {
  const presentations = emoji.match(/[^\uFE0F\uFE0E][\uFE0F\uFE0E]/g)?.length ?? 0
  const surrogatePairs = emoji.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0
  return emoji.length - presentations - surrogatePairs
}

function refusalMessage(error: unknown): string {
  const failure = error && typeof error === 'object' ? error as { status?: unknown; body?: unknown } : {}
  let messages: string[] = []
  if (typeof failure.body === 'string') {
    try {
      const body = JSON.parse(failure.body.slice(0, 8192))
      const message = body?.message
      if (typeof message === 'string') messages = [message]
      else if (Array.isArray(message) && message.every(item => typeof item === 'string')) messages = message
    } catch { /* Unknown bodies are never repeated. */ }
  }
  const normalized = messages.map(message => message.trim().replace(/\.$/, '').toLowerCase())
  if (failure.status === 400) {
    if (normalized.length === 1 && normalized[0] === 'this computer runs more than one agent in this chat. say which one reacts with fromagent.assistantid') {
      return 'More than one agent shares this pairing in that chat; retrying cannot help until this agent can be identified.'
    }
    const emojiRefusals = new Set([
      'emoji is required', 'emoji is not allowed', 'emoji not allowed',
      'emoji must be a string', 'emoji must be shorter than or equal to 32 characters',
    ])
    if (normalized.length > 0 && normalized.every(message => emojiRefusals.has(message))) {
      return 'That emoji is not allowed; choose another emoji instead of retrying.'
    }
    if (normalized.length === 1 && normalized[0] === 'only the chat owner can react as a human user') {
      return 'This agent is not allowed to react to that message; retrying will not help.'
    }
    return 'The server refused this reaction; retrying unchanged will not help.'
  }
  if (failure.status === 401) return 'This agent\'s pairing was not accepted; pair it again before retrying.'
  if (failure.status === 403) return 'This agent is not allowed to react to that message; retrying will not help.'
  if (failure.status === 404) return 'That message was not found or is not in this agent\'s chat; retrying will not help.'
  if (failure.status === 409) return 'The reaction could not be changed; resolve the conflict before retrying.'
  return 'The reaction could not be saved; try again later.'
}

export async function handleReactTool(
  rawArgs: unknown,
  deps: {
    authMode: 'pairing' | 'apikey'
    assistantId: string | null | undefined
    post: (path: string, body: Record<string, unknown>) => Promise<unknown>
  },
): Promise<ReactToolResult> {
  if (deps.authMode !== 'pairing') {
    return failure('Reactions need this agent to be paired; it cannot react with an account key.')
  }
  const configuredId = deps.assistantId
  if (typeof configuredId !== 'string' || !/^[1-9]\d*$/.test(configuredId) || !Number.isSafeInteger(Number(configuredId))) {
    return failure('Reactions need this agent\'s configured id; pair this agent again before retrying.')
  }
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? rawArgs as Record<string, unknown>
    : {}
  const { message_id, emoji, remove } = args
  if (typeof message_id !== 'string' || !/^[1-9]\d*$/.test(message_id) || !Number.isSafeInteger(Number(message_id))) {
    return failure('Use a valid message_id to react to a message.')
  }
  if (typeof emoji !== 'string' || !emoji.trim() || emojiLength(emoji) > 32) {
    return failure('Use a non-empty emoji of at most 32 characters.')
  }
  if (remove !== undefined && typeof remove !== 'boolean') {
    return failure('Set remove to true or false.')
  }
  try {
    // The server binds this fixed agent to the pairing. Never copy caller identity fields.
    await deps.post(`messages/${message_id}/reactions${remove ? '/remove' : ''}`, {
      emoji,
      fromAgent: { assistantId: Number(configuredId) },
    })
    return { content: [{ type: 'text' as const, text: remove ? 'You have no reaction with that emoji on that message.' : 'Reaction added.' }] }
  } catch (error) {
    // A refusal can contain private message, chat or actor data. None is a tool result.
    return failure(refusalMessage(error))
  }
}
