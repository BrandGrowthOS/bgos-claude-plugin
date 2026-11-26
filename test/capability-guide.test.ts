/**
 * Every bgos_capabilities answer stays well under Claude Code's tool result
 * limit (kit check 2026-11-25, finding 1; lib/capability-guide.ts).
 *
 * The tool used to return the whole served guide (207,587 characters for a
 * fully declaring 0.90.18 daemon, 208,282 with the reaction text) as ONE tool
 * result. Claude Code 2.1.332 keeps an MCP result only up to 25,000 tokens
 * (100,000 characters), so it refused the answer, saved it to a file the model
 * never read, and rule 1 never reached the model. The tool now answers with
 * the core rules plus a topic index, and one topic (or one part of it) per
 * call. Each answer is measured here in UTF-8 BYTES against
 * GUIDE_ANSWER_MAX_BYTES (20,000), a fifth of that limit, never in
 * .length: the canon carries emoji and arrows.
 *
 * The fixture is the real served text, rendered from BGOS main 8f4bce63e0
 * (renderCapabilities('claude', '0.90.18', <every token 0.90.18 declares>,
 * pairing 1)), gzipped. The other shapes are the ones a naive splitter breaks
 * on: one section longer than the cap, one LINE longer than the cap, a guide
 * at MAX_CAPABILITIES_BYTES where every line is a heading (so the index itself
 * must be paged), and the two bundled fallbacks.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { MAX_CAPABILITIES_BYTES, capabilitiesFallbackFor } from '../lib/capabilities.ts'
import { CORE_RULES_TEXT, OWNER_CHAT_ACK_RULE } from '../lib/core-rules.ts'
import { REACTION_GUIDANCE } from '../lib/heard-reaction.ts'
import { HARD_FLOOR_TOKEN, PERMISSION_CARD } from '../lib/claude-capability-tokens.js'

const loaded = await import('../lib/capability-guide.ts').catch(() => null)
function guide() {
  assert.ok(loaded, 'lib/capability-guide.ts must exist')
  return loaded
}

const SERVED = gunzipSync(readFileSync(new URL('./fixtures/served-canon-claude-2026-11-25.txt.gz', import.meta.url))).toString('utf8')
const bytes = (s: string) => Buffer.byteLength(s, 'utf8')
const extras = { coreRules: CORE_RULES_TEXT, trailer: REACTION_GUIDANCE }

type Answer = { text: string; isError?: boolean }

/** Every answer the tool can give for one guide text: the default, each index part, each topic part, and the refusals. */
function everyAnswer(text: string): Array<[string, Answer]> {
  const g = guide()
  const out: Array<[string, Answer]> = []
  const ask = (label: string, args: unknown) => out.push([label, g.capabilityGuideAnswer(text, args, extras)])
  ask('default', {})
  ask('no arguments at all', undefined)
  const parsed = g.parseGuide(text)
  for (let part = 1; part <= g.indexPartCount(text, extras); part++) ask(`index part ${part}`, { topic: 'index', part })
  for (const topic of parsed.topics) {
    ask(`${topic.id}`, { topic: topic.id })
    for (let part = 1; part <= topic.parts.length; part++) ask(`${topic.id} part ${part}`, { topic: topic.id, part })
  }
  ask('unknown topic', { topic: 'no-such-topic' })
  ask('huge unknown topic', { topic: 'x'.repeat(100_000) })
  ask('part past the end', { topic: parsed.topics[0]?.id ?? 'index', part: 9999 })
  ask('part zero', { topic: parsed.topics[0]?.id ?? 'index', part: 0 })
  ask('topic not a string', { topic: 42 })
  return out
}

function assertAllUnderCap(text: string, where: string): Array<[string, Answer]> {
  const { GUIDE_ANSWER_MAX_BYTES } = guide()
  const answers = everyAnswer(text)
  for (const [label, answer] of answers) {
    assert.ok(bytes(answer.text) <= GUIDE_ANSWER_MAX_BYTES, `${where}, ${label}: ${bytes(answer.text)} bytes`)
    assert.ok(answer.text.length > 0, `${where}, ${label}: empty`)
  }
  return answers
}

test('the cap is well under Claude Code\'s tool result limit (25,000 tokens, kept as 100,000 characters)', () => {
  const { GUIDE_ANSWER_MAX_BYTES } = guide()
  assert.ok(GUIDE_ANSWER_MAX_BYTES <= 100_000 / 4, `${GUIDE_ANSWER_MAX_BYTES} is not well under the limit`)
})

test('the real served guide (207,587 characters) is no longer one answer: every answer is under the cap', () => {
  assert.ok(SERVED.length > 200_000, 'the fixture is the full guide')
  assertAllUnderCap(SERVED, 'served')
})

test('the default answer carries the core rules, rule 1 included, and an index of the guide\'s topics', () => {
  const { capabilityGuideAnswer, parseGuide } = guide()
  const answer = capabilityGuideAnswer(SERVED, {}, extras)
  assert.equal(answer.isError, undefined)
  assert.ok(answer.text.startsWith('# BGOS Channel Agent Capabilities'), 'keeps the guide header')
  assert.ok(answer.text.includes(CORE_RULES_TEXT))
  assert.ok(answer.text.includes(OWNER_CHAT_ACK_RULE))
  assert.ok(answer.text.includes(REACTION_GUIDANCE), 'the reaction guidance still rides the default answer')
  const topics = parseGuide(SERVED).topics
  assert.ok(topics.length >= 30, `only ${topics.length} topics`)
  for (const topic of topics) assert.ok(answer.text.includes(`- ${topic.id}: ${topic.title}`), `index lacks ${topic.id}`)
  assert.match(answer.text, /bgos_capabilities with \{"topic": "<id>"\}/)
})

test('the topics together are the whole guide: nothing served is dropped by the split', () => {
  const { parseGuide } = guide()
  const parsed = parseGuide(SERVED)
  const rebuilt = parsed.head + parsed.topics.map((t) => t.parts.join('')).join('')
  assert.equal(rebuilt, SERVED)
})

test('a topic is found by its id, by its title and by its heading words in any case', () => {
  const { capabilityGuideAnswer } = guide()
  const byId = capabilityGuideAnswer(SERVED, { topic: 'conversation-model' }, extras)
  assert.equal(byId.isError, undefined)
  assert.ok(byId.text.includes('ACKNOWLEDGE WITH A REACTION, NOT A REPLY.'), 'rule 1 lives in Conversation model')
  for (const topic of ['Conversation model', 'CONVERSATION MODEL', '## Conversation model', ' conversation model ']) {
    assert.equal(capabilityGuideAnswer(SERVED, { topic }, extras).text, byId.text, topic)
  }
})

test('a topic longer than the cap comes in parts that say where the next part is', () => {
  const { capabilityGuideAnswer, parseGuide } = guide()
  const missions = parseGuide(SERVED).topics.find((t) => t.id === 'missions')
  assert.ok(missions, 'Missions is a topic')
  assert.ok(missions.parts.length >= 2, 'Missions (24 KB) is split')
  const first = capabilityGuideAnswer(SERVED, { topic: 'missions' }, extras)
  assert.match(first.text, /part 1 of \d+/)
  assert.match(first.text, /\{"topic": "missions", "part": 2\}/)
  const last = capabilityGuideAnswer(SERVED, { topic: 'missions', part: missions.parts.length }, extras)
  assert.doesNotMatch(last.text, /"part": \d+\}/, 'the last part names no next part')
})

test('an unknown topic or part is a short refusal that points back to the index', () => {
  const { capabilityGuideAnswer } = guide()
  const unknown = capabilityGuideAnswer(SERVED, { topic: 'no-such-topic' }, extras)
  assert.equal(unknown.isError, true)
  assert.match(unknown.text, /no topic/i)
  assert.match(unknown.text, /without a topic/)
  const past = capabilityGuideAnswer(SERVED, { topic: 'missions', part: 99 }, extras)
  assert.equal(past.isError, true)
  assert.match(past.text, /part from 1 to \d+/)
  const huge = capabilityGuideAnswer(SERVED, { topic: 'y'.repeat(10_000) }, extras)
  assert.ok(huge.text.length < 600, 'an unknown topic is not echoed whole')
})

test('a section that is one line longer than the cap is split inside the line, on a code point boundary', () => {
  const { GUIDE_ANSWER_MAX_BYTES, parseGuide } = guide()
  const line = 'Long words 🙏 with no sentence end '.repeat(Math.ceil((GUIDE_ANSWER_MAX_BYTES * 3) / 30))
  const text = `# BGOS Channel Agent Capabilities\n(channel: claude, canon x)\n\nIntro.\n\n## One huge line\n${line}\n\n## After\nTail.\n`
  const answers = assertAllUnderCap(text, 'one huge line')
  const topic = parseGuide(text).topics.find((t) => t.id === 'one-huge-line')
  assert.ok(topic && topic.parts.length >= 3)
  assert.equal(topic.parts.join(''), `## One huge line\n${line}\n\n`, 'the parts are the section, byte for byte')
  for (const [, answer] of answers) assert.equal(/�/.test(answer.text), false, 'a part cut a character in half')
})

test('a guide at the accepted maximum where every line is a heading pages its own index', () => {
  const { indexPartCount, capabilityGuideAnswer } = guide()
  const lines: string[] = ['# BGOS Channel Agent Capabilities', '(channel: claude, canon x)', '']
  let size = 0
  for (let i = 0; size < MAX_CAPABILITIES_BYTES - 200; i++) {
    const line = `## Heading number ${i} about a capability`
    lines.push(line)
    size += line.length + 1
  }
  const text = lines.join('\n')
  assert.ok(bytes(text) <= MAX_CAPABILITIES_BYTES)
  assert.ok(indexPartCount(text, extras) >= 2, 'the index is paged')
  const first = capabilityGuideAnswer(text, {}, extras)
  assert.ok(first.text.includes(CORE_RULES_TEXT), 'the core rules come first even then')
  assert.match(first.text, /\{"topic": "index", "part": 2\}/)
  assertAllUnderCap(text, 'every line a heading')
})

test('a guide whose text before the first topic is longer than the cap still answers under it', () => {
  const text = `# BGOS Channel Agent Capabilities\n(channel: claude, canon x)\n\n${'An intro sentence. '.repeat(5000)}\n\n## Only topic\nBody.\n`
  assertAllUnderCap(text, 'huge intro')
})

test('both bundled fallbacks answer under the cap, with the core rules', () => {
  const { capabilityGuideAnswer } = guide()
  for (const declared of [[], [HARD_FLOOR_TOKEN, PERMISSION_CARD]]) {
    const fallback = capabilitiesFallbackFor(declared)
    assertAllUnderCap(fallback, `fallback ${declared.join(',') || 'none declared'}`)
    const answer = capabilityGuideAnswer(fallback, {}, extras)
    assert.ok(answer.text.includes(CORE_RULES_TEXT))
    assert.ok(answer.text.includes('bundled fallback'))
  }
})

test('an empty or headingless guide answers its text with the rules', () => {
  const { capabilityGuideAnswer } = guide()
  const answer = capabilityGuideAnswer('', {}, extras)
  assert.ok(answer.text.includes(CORE_RULES_TEXT))
  assertAllUnderCap('Just a line of text.', 'headingless')
})
