/**
 * The bgos_capabilities answer, in topics (kit check 2026-11-25, finding 1).
 *
 * The served guide is about 208,000 characters for a fully declaring daemon,
 * and the tool used to return all of it as one result. Claude Code keeps an
 * MCP result only up to 25,000 tokens (2.1.332: 100,000 characters), so it
 * refused that answer and saved it to a file the model never read; nothing in
 * the guide, rule 1 included, reached the model. Now:
 *
 *  - with no topic, the tool answers the guide's header and introduction, the
 *    core rules (lib/core-rules.ts, the same block the MCP instructions open
 *    with), an index of the guide's topics, and the trailer the caller passes
 *    (the reaction guidance);
 *  - with a topic, it answers that one section, in parts when the section is
 *    longer than one answer may be, each part naming the next.
 *
 * A topic is a `## ` or `### ` heading of the served text and everything up
 * to the next one, so the split works on today's backend and on any canon
 * built the same way, and the topics put back together are the guide byte for
 * byte (test/capability-guide.test.ts). Every answer, the refusals included,
 * is at most GUIDE_ANSWER_MAX_BYTES in UTF-8, a fifth of Claude Code's limit;
 * a guide too big to index in one answer pages its index too. Never throws on
 * any argument. No em or en dashes in the words added here: they are a prompt.
 */

/** The most one bgos_capabilities answer may carry, in UTF-8 bytes. */
export const GUIDE_ANSWER_MAX_BYTES = 20_000

/** Room kept in every part for the line that says which part it is and where the next one is. */
const PART_NOTE_ROOM = 400
/** The most of a topic one part carries. */
const PART_BODY_MAX = GUIDE_ANSWER_MAX_BYTES - PART_NOTE_ROOM
/**
 * The text before the first topic is shown whole in the default answer only up to this; past it, it is a topic.
 * Room for the whole bundled fallback (about 10,800 bytes, which has no topics), so an agent whose fetch failed
 * still reads all of it in one answer. With the rules (at most RULES_SHOWN_MAX), the index heading and the
 * trailer (at most TRAILER_SHOWN_MAX) it stays inside one answer.
 */
const HEAD_SHOWN_MAX = 11_000
const RULES_SHOWN_MAX = 5_000
const TRAILER_SHOWN_MAX = 1_500
const GOLDEN_RULES_TOPIC = 'golden-rules'
const GOLDEN_SHOWN_MAX = 1_500
/** The topic the index itself is paged under. */
export const INDEX_TOPIC = 'index'
const INTRODUCTION_TOPIC = 'introduction'
const TITLE_MAX = 120
const ECHO_MAX = 60

export type GuideTopic = {
  /** What the model passes back as `topic`: the heading's words, lower case, joined by hyphens. */
  id: string
  /** The heading's words. */
  title: string
  /** The section, heading line included, in pieces of at most PART_BODY_MAX bytes; joined, the section exactly. */
  parts: string[]
}

export type Guide = {
  /** Everything before the first topic heading. */
  head: string
  topics: GuideTopic[]
}

export type GuideExtras = {
  /** The core rules block, put first in the default answer. */
  coreRules: string
  /** Put last in the default answer (the reaction guidance). */
  trailer?: string
}

export type GuideAnswer = { text: string; isError?: true }

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

const HEADING = /^#{2,3} \S/

/** The heading's words, without its hashes, on one bounded line. */
function titleOf(line: string): string {
  const words = line.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim()
  return words.length > TITLE_MAX ? words.slice(0, TITLE_MAX).trimEnd() : words
}

/** The id a topic is asked for by: lower case letters and digits joined by single hyphens. */
export function topicSlug(words: string): string {
  return words
    .toLowerCase()
    .replace(/^#+\s*/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
}

/** Cut `s` at no more than `max` UTF-8 bytes, never inside a character. Returns the head. */
function headByBytes(s: string, max: number): string {
  if (bytes(s) <= max) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (bytes(s.slice(0, mid)) <= max) lo = mid
    else hi = mid - 1
  }
  let end = lo
  // Never leave the high half of a surrogate pair at the end.
  const last = s.charCodeAt(end - 1)
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1
  return s.slice(0, end)
}

/**
 * One line longer than a part, in pieces: at the last sentence end, else the
 * last space, inside the budget, else at the budget itself. Joined, the line.
 */
function splitLongLine(line: string, max: number): string[] {
  const out: string[] = []
  let rest = line
  while (bytes(rest) > max) {
    const head = headByBytes(rest, max)
    let cut = head.lastIndexOf('. ')
    if (cut >= head.length / 2) cut += 2
    else {
      cut = head.lastIndexOf(' ')
      cut = cut >= head.length / 2 ? cut + 1 : head.length
    }
    if (cut <= 0) cut = head.length
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) out.push(rest)
  return out
}

/** A section in parts of at most `max` bytes, cut at line ends where it can be; joined, the section. */
function splitSection(section: string, max: number): string[] {
  if (bytes(section) <= max) return [section]
  const pieces: string[] = []
  for (const line of section.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (bytes(line) <= max) pieces.push(line)
    else pieces.push(...splitLongLine(line, max))
  }
  const parts: string[] = []
  let current = ''
  for (const piece of pieces) {
    if (current && bytes(current) + bytes(piece) > max) {
      parts.push(current)
      current = ''
    }
    current += piece
  }
  if (current) parts.push(current)
  return parts
}

let memo: { text: string; guide: Guide } | null = null

/** The guide's head and topics. Joined back (head, then each topic's parts), the text exactly. */
export function parseGuide(text: string): Guide {
  if (memo && memo.text === text) return memo.guide
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  let head = ''
  const sections: Array<{ title: string; text: string; id: string }> = []
  let parent = ''
  for (const line of lines) {
    if (HEADING.test(line)) {
      // A ### topic names the ## topic it sits in: the served guide has two topics called Boards.
      const title = titleOf(line)
      const sub = line.startsWith('### ') && parent !== ''
      if (!sub) parent = title
      sections.push({ title: sub ? titleOf(`${title} (in ${parent})`) : title, text: line, id: topicSlug(title) })
    } else if (sections.length) sections[sections.length - 1]!.text += line
    else head += line
  }
  const taken = new Set<string>([INDEX_TOPIC, INTRODUCTION_TOPIC])
  const topics: GuideTopic[] = []
  if (bytes(head) > HEAD_SHOWN_MAX) {
    topics.push({ id: INTRODUCTION_TOPIC, title: 'Introduction', parts: splitSection(head, PART_BODY_MAX) })
  }
  for (const section of sections) {
    const base = section.id || 'topic'
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    taken.add(id)
    topics.push({ id, title: section.title || id, parts: splitSection(section.text, PART_BODY_MAX) })
  }
  const guide = { head, topics }
  memo = { text, guide }
  return guide
}

function indexLine(topic: GuideTopic): string {
  const parts = topic.parts.length > 1 ? ` (${topic.parts.length} parts)` : ''
  return `- ${topic.id}: ${topic.title}${parts}\n`
}

const HOW_TO_READ =
  'This guide is in topics so each answer stays small. Call bgos_capabilities with {"topic": "<id>"} to read one; ' +
  'a topic in parts says which part comes next. Read the topic before you use a capability you are unsure of.\n'

/** The default answer's parts before the index, each already bounded. */
function opening(guide: Guide, extras: GuideExtras): string {
  const head = bytes(guide.head) > HEAD_SHOWN_MAX
    ? headByBytes(guide.head.split('\n')[0] ?? '', 200) + '\n(The introduction is the topic "introduction".)\n\n'
    : guide.head
  const rules = headByBytes(extras.coreRules, RULES_SHOWN_MAX)
  // The guide's own Golden rules are short and hold the reply mandate: shown here too, and still a topic.
  const golden = guide.topics.find((t) => t.id === GOLDEN_RULES_TOPIC)
  const goldenText = golden && golden.parts.length === 1 && bytes(golden.parts[0]!) <= GOLDEN_SHOWN_MAX
    ? `\n\n${golden.parts[0]!.trimEnd()}`
    : ''
  return `${head}${head && !head.endsWith('\n\n') ? '\n' : ''}${rules}${goldenText}\n\n## Topics\n${HOW_TO_READ}`
}

function trailerOf(extras: GuideExtras): string {
  return extras.trailer ? `\n${headByBytes(extras.trailer, TRAILER_SHOWN_MAX)}` : ''
}

/** The index lines, paged: the first page fits beside the opening and trailer, the rest under the cap alone. */
function indexPages(guide: Guide, extras: GuideExtras): string[][] {
  const room = GUIDE_ANSWER_MAX_BYTES - PART_NOTE_ROOM
  const firstRoom = room - bytes(opening(guide, extras)) - bytes(trailerOf(extras))
  const pages: string[][] = [[]]
  let used = 0
  for (const topic of guide.topics) {
    const line = indexLine(topic)
    const limit = pages.length === 1 ? firstRoom : room - 200
    if (used + bytes(line) > limit && pages[pages.length - 1]!.length > 0) {
      pages.push([])
      used = 0
    }
    pages[pages.length - 1]!.push(line)
    used += bytes(line)
  }
  return pages
}

/** How many pages the index of this guide takes (1 for every guide the backend serves today). */
export function indexPartCount(text: string, extras: GuideExtras): number {
  return indexPages(parseGuide(text), extras).length
}

const next = (topic: string, part: number) => `{"topic": "${topic}", "part": ${part}}`

/** Last resort: never over the cap, whatever went before. */
function bounded(answer: GuideAnswer): GuideAnswer {
  if (bytes(answer.text) <= GUIDE_ANSWER_MAX_BYTES) return answer
  const note = '\n(cut to stay under the tool result limit)'
  return { ...answer, text: headByBytes(answer.text, GUIDE_ANSWER_MAX_BYTES - bytes(note)) + note }
}

function refusal(text: string): GuideAnswer {
  return bounded({ text, isError: true })
}

/** What the model asked for, made safe to repeat in one short line. */
function echo(value: string): string {
  const one = value.replace(/[\u0000-\u001f\u007f"]+/g, ' ').trim()
  return one.length > ECHO_MAX ? `${one.slice(0, ECHO_MAX)}...` : one
}

function findTopic(guide: Guide, asked: string): GuideTopic | undefined {
  const wanted = topicSlug(asked)
  if (!wanted) return undefined
  return guide.topics.find((t) => t.id === wanted) ?? guide.topics.find((t) => topicSlug(t.title) === wanted)
}

function partOf(args: Record<string, unknown>): number | null {
  const raw = args.part
  if (raw === undefined || raw === null) return 1
  const n = typeof raw === 'string' && /^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : raw
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : null
}

/**
 * The answer to one bgos_capabilities call on this guide text. `args` is the
 * call's raw arguments: `topic` (an id, a title or a heading) and `part`
 * (1 based). Never throws, never over GUIDE_ANSWER_MAX_BYTES.
 */
export function capabilityGuideAnswer(text: string, rawArgs: unknown, extras: GuideExtras): GuideAnswer {
  const guide = parseGuide(typeof text === 'string' ? text : '')
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {}
  const topicArg = args.topic
  if (topicArg !== undefined && topicArg !== null && typeof topicArg !== 'string') {
    return refusal('Pass topic as a string: a topic id from the index. Call bgos_capabilities without a topic for the index.')
  }
  const asked = typeof topicArg === 'string' ? topicArg.trim() : ''
  const part = partOf(args)
  const pages = indexPages(guide, extras)

  if (!asked || topicSlug(asked) === INDEX_TOPIC) {
    if (part === null || part < 1 || part > pages.length) {
      return refusal(`The index has ${pages.length} part${pages.length === 1 ? '' : 's'}; pass part from 1 to ${pages.length}.`)
    }
    const more = part < pages.length
      ? `More topics: call bgos_capabilities with ${next(INDEX_TOPIC, part + 1)}.\n`
      : ''
    if (part === 1) {
      const list = guide.topics.length ? pages[0]!.join('') : '(This copy of the guide has no topics: all of it is above.)\n'
      return bounded({ text: `${opening(guide, extras)}${list}${more}${trailerOf(extras)}` })
    }
    return bounded({ text: `## Topics (part ${part} of ${pages.length})\n${HOW_TO_READ}${pages[part - 1]!.join('')}${more}` })
  }

  const topic = findTopic(guide, asked)
  if (!topic) {
    return refusal(`There is no topic "${echo(asked)}" in this guide. Call bgos_capabilities without a topic for the index of topic ids.`)
  }
  const count = topic.parts.length
  if (part === null || part < 1 || part > count) {
    return refusal(`Topic "${topic.id}" has ${count} part${count === 1 ? '' : 's'}; pass part from 1 to ${count}.`)
  }
  const body = topic.parts[part - 1]!
  if (count === 1) return bounded({ text: body })
  const note = part < count
    ? `\n(Topic "${topic.id}", part ${part} of ${count}. Next: call bgos_capabilities with ${next(topic.id, part + 1)}.)`
    : `\n(Topic "${topic.id}", part ${part} of ${count}, the last.)`
  return bounded({ text: `${body}${body.endsWith('\n') ? '' : '\n'}${note}` })
}
