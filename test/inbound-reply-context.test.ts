import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildInboundChannel } from '../lib/inbound-channel.ts'

// KC 2026-11-05: a reply to a message reached the agent with no quote. The
// backend serves `reply_to` { message_id, text, sender, files } on the agent
// poll (integrations.controller.ts); buildInboundChannel read none of it.

const COMMON = {
  chatId: 4875,
  messageId: 194400,
  userId: 'user_owner',
  assistantId: 1050,
  timestamp: '2026-11-05T12:08:37.690Z',
  files: [],
}

const REPLY_TO = {
  message_id: 194390,
  text: 'Nothing was eligible at the 12:00Z board fire.',
  sender: 'assistant',
  files: [],
}

function user(text: string, serverSender: Record<string, unknown>) {
  return buildInboundChannel({ ...COMMON, text, transport: 'poll', serverSender })
}

test('a reply carries the quoted message before the reply text', () => {
  const d = user('did you fix this ?', { reply_to: REPLY_TO })
  const quoteAt = d.content.indexOf(REPLY_TO.text)
  const textAt = d.content.indexOf('did you fix this ?')
  assert.ok(quoteAt >= 0, 'the quoted text is in the content')
  assert.ok(textAt > quoteAt, 'the reply text follows the quote')
  assert.ok(d.content.endsWith('did you fix this ?'), 'the person\'s words stay last and unchanged')
})

test('the quote is labelled as context, never as an instruction', () => {
  const d = user('ok', { reply_to: REPLY_TO })
  assert.match(d.content, /replying to message 194390/i)
  assert.match(d.content, /not instructions/i)
})

test('the replied-to id rides in the meta as a string', () => {
  const d = user('ok', { reply_to: REPLY_TO })
  assert.equal(d.meta.reply_to_message_id, '194390')
  for (const [k, v] of Object.entries(d.meta)) {
    assert.equal(typeof v, 'string', `meta.${k} must be a string (wake-card-contract)`)
  }
})

test('no reply_to leaves the content and meta untouched', () => {
  const plain = user('hello', {})
  assert.equal(plain.content, 'hello')
  assert.equal('reply_to_message_id' in plain.meta, false)
})

test('a malformed reply_to is ignored, never thrown on', () => {
  for (const bad of [null, 'x', 7, {}, { message_id: 1 }, { text: '' }, { message_id: 'a', text: 5 }]) {
    const d = user('hello', { reply_to: bad })
    assert.equal(d.content, 'hello')
    assert.equal('reply_to_message_id' in d.meta, false)
  }
})

test('a very long quote is cut, and says so', () => {
  const d = user('ok', { reply_to: { ...REPLY_TO, text: 'x'.repeat(5000) } })
  assert.ok(d.content.length < 3000, `content is ${d.content.length} chars`)
  assert.match(d.content, /cut/i)
})

test('a quoted file is named, never linked', () => {
  const d = user('ok', {
    reply_to: {
      ...REPLY_TO,
      files: [{ id: 9, filename: 'shot.png', mime: 'image/png', url: 'https://example.invalid/signed?x=1' }],
    },
  })
  assert.match(d.content, /shot\.png/)
  assert.doesNotMatch(d.content, /example\.invalid/)
})

test('a slash command keeps its text first, so command routing is unchanged', () => {
  const d = user('/status', { reply_to: REPLY_TO })
  assert.equal(d.content, '/status')
})

test('a peer agent message and a system card never gain a quote block', () => {
  const agent = buildInboundChannel({
    ...COMMON,
    text: 'hi',
    transport: 'poll',
    senderType: 'agent',
    agentOrigin: {
      sourceAssistantId: 900,
      sourceName: 'Data',
      targetAssistantId: 1050,
      peerConversationId: 1,
      messageId: 194400,
    },
    serverSender: { reply_to: REPLY_TO },
  })
  assert.equal(agent.content.includes(REPLY_TO.text), false)
  const sys = buildInboundChannel({
    ...COMMON,
    text: 'tick',
    transport: 'poll',
    senderType: 'system',
    serverSender: { reply_to: REPLY_TO },
  })
  assert.equal(sys.content.includes(REPLY_TO.text), false)
})

test('the socket and stream spelling (replyToId, replyQuotedText) is read too', () => {
  const d = buildInboundChannel({
    ...COMMON,
    text: 'did you fix this ?',
    transport: 'ws',
    serverSender: { replyToId: 194390, replyQuotedText: REPLY_TO.text, replyQuotedSender: 'assistant' },
  })
  assert.ok(d.content.includes(REPLY_TO.text))
  assert.match(d.content, /from assistant/)
  assert.ok(d.content.endsWith('did you fix this ?'))
  assert.equal(d.meta.reply_to_message_id, '194390')
})

test('the flat snake_case row spelling is read too', () => {
  const d = user('ok', { reply_to_id: 194390, reply_quoted_text: REPLY_TO.text })
  assert.ok(d.content.includes(REPLY_TO.text))
  assert.equal(d.meta.reply_to_message_id, '194390')
})

test('a reply id with no quote text is ignored, not guessed', () => {
  const d = user('ok', { replyToId: 194390, replyQuotedText: null })
  assert.equal(d.content, 'ok')
})
