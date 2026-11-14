export const REACT_TOOL = {
  name: 'react',
  description:
    'React to a message with one emoji per message. A new emoji replaces the old one. ' +
    'Use it to acknowledge or agree, not instead of a reply. Set remove to true to remove that emoji.',
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

export async function handleReactTool(
  rawArgs: unknown,
  deps: { post: (path: string, body: Record<string, unknown>) => Promise<unknown> },
): Promise<ReactToolResult> {
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
    // The pairing identifies the actor on the server. Never copy caller fields
    // or send fromAgent, an agent id, or a caller identity header here.
    await deps.post(`messages/${message_id}/reactions${remove ? '/remove' : ''}`, { emoji })
    return { content: [{ type: 'text' as const, text: remove ? 'Reaction removed.' : 'Reaction added.' }] }
  } catch {
    // A refusal can contain private message, chat or actor data. None is a tool result.
    return failure('The reaction could not be saved.')
  }
}
