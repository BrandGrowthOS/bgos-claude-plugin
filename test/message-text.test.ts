/**
 * Eval suite for the BGOS Claude Code plugin message-text pipeline.
 *
 * Run with:  npm test      (node --test, no extra deps)
 *
 * Coverage:
 *   - Backslash / escaping round-trip on the WIRE (JSON over fetch + JSON-RPC).
 *   - Markdown-rendering backslash protection (the actual user-visible bug):
 *     a deterministic CommonMark backslash simulator proves that without the fix
 *     prose backslashes are lost, and that the fix makes them render as exactly
 *     one literal backslash, while leaving code spans/fences and non-escapable
 *     sequences untouched.
 *   - Inbound parsing: verbatim text + attachment-line shaping for both the WS
 *     and poll payload shapes.
 *   - File-attachment mime handling (category + guess + doc set).
 *   - Button-value namespace isolation round-trip.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  guessMimeType,
  getFileCategory,
  escapeAgentButtonValue,
  unescapeAgentButtonValue,
  collidesWithReserved,
  protectBackslashesForMarkdown,
  buildInboundContent,
  buildEventMeta,
} from '../lib/message-text.ts'

// ── Deterministic CommonMark backslash simulator ─────────────────────────────
// Models exactly the one rule that loses backslashes: outside code, a backslash
// before ASCII punctuation is consumed (the backslash vanishes, the punctuation
// becomes literal); a backslash before any other char stays literal. This lets
// the suite assert renderer behavior with zero dependency on markdown-it, while
// still being faithful to the CommonMark spec for this rule.
const CM_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[]\\^_`{|}~'.split(''))
function renderCommonMarkBackslashes(src: string): string {
  // Only handles non-code text; tests feed it the prose portions.
  let out = ''
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\\' && i + 1 < src.length && CM_PUNCT.has(src[i + 1]!)) {
      out += src[i + 1]
      i++
      continue
    }
    out += src[i]
  }
  return out
}

// ── 1. Wire round-trip (JSON) is lossless ────────────────────────────────────

test('wire: JSON.stringify/parse preserves backslashes exactly', () => {
  const samples = [
    'C:\\Users\\kc',
    'regex \\d+ \\w* \\s?',
    'two \\\\ backslashes',
    'tab\\tnewline\\nliteral-escapes-as-text',
    'quote " and \' and `tick`',
    'unicode é 你好 😀',
    '```js\nconst re = /\\d+/g\n```',
  ]
  for (const s of samples) {
    const decoded = JSON.parse(JSON.stringify({ text: s })).text
    assert.equal(decoded, s, `round-trip failed for ${JSON.stringify(s)}`)
  }
})

// ── 2. The bug: CommonMark eats prose backslashes WITHOUT the fix ────────────

test('repro: CommonMark drops a prose backslash before punctuation (the bug)', () => {
  assert.equal(renderCommonMarkBackslashes('a\\*b'), 'a*b')
  assert.equal(renderCommonMarkBackslashes('a\\_b'), 'a_b')
  assert.equal(renderCommonMarkBackslashes('see \\[note]'), 'see [note]')
  // Double backslash collapses to one literal backslash.
  assert.equal(renderCommonMarkBackslashes('x\\\\y'), 'x\\y')
})

// ── 3. The fix: protected text renders to exactly one literal backslash ───────

test('fix: protected prose renders back to the agent input verbatim', () => {
  // The core invariant: render(protect(input)) === input, for every backslash
  // shape an agent realistically emits in prose. (input is also what we want on
  // screen, since the agent typed literal characters.)
  const inputs = [
    'a\\*b',                 // literal backslash + literal star
    'a\\_b',
    'see \\[note]',
    'x\\\\y',                // two literal backslashes
    'regex \\d+ \\w* \\s?',  // backslash before non-escapable letters
    'path C:\\Users\\kc',
    'newline \\n literal',
    'a\\*b and \\d and C:\\x', // mixed in one run
  ]
  for (const input of inputs) {
    const protectedText = protectBackslashesForMarkdown(input)
    const rendered = renderCommonMarkBackslashes(protectedText)
    assert.equal(
      rendered,
      input,
      `input ${JSON.stringify(input)} -> protected ${JSON.stringify(protectedText)} -> rendered ${JSON.stringify(rendered)}`,
    )
  }
})

test('repro vs fix: bare input loses backslashes, protected input does not', () => {
  const input = 'a\\*b'
  assert.equal(renderCommonMarkBackslashes(input), 'a*b') // the bug
  assert.equal(renderCommonMarkBackslashes(protectBackslashesForMarkdown(input)), 'a\\*b') // fixed
})

test('fix: code spans and fences are NOT modified', () => {
  const inline = 'use `C:\\Users\\x` and `\\d+` here'
  assert.equal(protectBackslashesForMarkdown(inline), inline)

  const fenced = '```\nC:\\Users\\x\nregex \\*literal\\* \\\\\n```'
  assert.equal(protectBackslashesForMarkdown(fenced), fenced)

  // Mixed: prose around a fence - only the prose backslashes are protected, the
  // fence content stays byte-for-byte.
  const mixed = 'before \\* after\n```\nkeep \\* raw\n```\nend \\_'
  const out = protectBackslashesForMarkdown(mixed)
  assert.ok(out.includes('keep \\* raw'), 'fence content must be verbatim')
  // Prose backslashes must be doubled (escaped) so they survive rendering.
  assert.ok(out.includes('before \\\\\\* after'), 'prose star must be protected')
  assert.ok(out.includes('end \\\\\\_'), 'trailing prose underscore must be protected')
})

test('fix: text with no backslashes is returned identical (fast path)', () => {
  const s = 'plain **bold** _italic_ and a [link](https://x.dev)'
  assert.equal(protectBackslashesForMarkdown(s), s)
})

test('fix: tilde fences are honored too', () => {
  const t = 'prose \\* here\n~~~\nraw \\* inside\n~~~'
  const out = protectBackslashesForMarkdown(t)
  assert.ok(out.includes('raw \\* inside'))
  assert.ok(out.includes('prose \\\\\\* here'))
})

// ── 4. Inbound parsing: verbatim text + attachment shaping ───────────────────

test('inbound: user text is forwarded verbatim (backslashes preserved)', () => {
  const text = 'try C:\\Users\\kc and /\\d+/ and "quotes"'
  assert.equal(buildInboundContent(text), text)
})

test('inbound: WS file shape produces an attachment line (no em dash)', () => {
  const content = buildInboundContent('look', [
    { filename: 'a.png', mime: 'image/png', url: 'https://cdn/x.png' },
    { filename: 'doc.pdf', mime: 'application/pdf', dataUri: 'data:application/pdf;base64,AAA' },
  ])
  assert.equal(
    content,
    'look\n[Attached image: a.png - https://cdn/x.png]\n[Attached document: doc.pdf - data:application/pdf;base64,AAA]',
  )
  assert.ok(!content.includes(', '), 'must not contain an em dash')
  assert.ok(!content.includes(', '), 'must not contain an en dash')
})

test('inbound: poll file shape produces an attachment line', () => {
  const content = buildInboundContent('hi', [
    { isImage: true, fileName: 'p.jpg', fileData: 'https://s3/p.jpg' },
    { isVideo: true, fileName: 'v.mp4', fileData: 'https://s3/v.mp4' },
  ])
  assert.equal(
    content,
    'hi\n[Attached image: p.jpg - https://s3/p.jpg]\n[Attached video: v.mp4 - https://s3/v.mp4]',
  )
})

test('inbound: WS file with no ref is skipped', () => {
  const content = buildInboundContent('', [{ filename: 'x.png', mime: 'image/png', url: '' }])
  assert.equal(content, '')
})

test('inbound: backlog prefix is prepended when supplied', () => {
  const content = buildInboundContent('hey', [], {
    backlogPrefix: '[backlog - message arrived while you were offline; please respond]',
  })
  assert.equal(
    content,
    '[backlog - message arrived while you were offline; please respond]\nhey',
  )
})

test('inbound: empty text and no files yields empty content', () => {
  assert.equal(buildInboundContent('   '), '')
  assert.equal(buildInboundContent(''), '')
})

// ── 5. File-attachment mime handling ─────────────────────────────────────────

test('mime: guessMimeType resolves known extensions case-insensitively', () => {
  assert.equal(guessMimeType('photo.PNG'), 'image/png')
  assert.equal(guessMimeType('clip.mp4'), 'video/mp4')
  assert.equal(guessMimeType('notes.YAML'), 'application/yaml')
  assert.equal(guessMimeType('archive.zip'), 'application/zip')
  assert.equal(guessMimeType('weird.unknownext'), null)
  assert.equal(guessMimeType('noext'), null)
  assert.equal(guessMimeType('.dotfile'), null)
})

test('mime: getFileCategory buckets by prefix and doc set', () => {
  assert.equal(getFileCategory('image/png'), 'image')
  assert.equal(getFileCategory('VIDEO/MP4'), 'video')
  assert.equal(getFileCategory('audio/mpeg'), 'audio')
  assert.equal(getFileCategory('application/pdf'), 'document')
  assert.equal(getFileCategory('application/yaml'), 'document')
  assert.equal(getFileCategory('text/x-unsupported'), null)
})

// ── 6. Button-value namespace isolation round-trip ───────────────────────────

test('buttons: agent value round-trips through the u: namespace', () => {
  const values = ['choose-a', 'C:\\path', 'has spaces', 'perm:once:abcde', '__skip__']
  for (const v of values) {
    const wire = escapeAgentButtonValue(v)
    assert.ok(wire.startsWith('u:'))
    assert.equal(unescapeAgentButtonValue(wire), v, `round-trip failed for ${JSON.stringify(v)}`)
  }
})

test('buttons: reserved sentinels pass through unescaped on the way back', () => {
  assert.equal(unescapeAgentButtonValue('__skip__'), '__skip__')
  assert.equal(unescapeAgentButtonValue('__custom__'), '__custom__')
  assert.equal(unescapeAgentButtonValue('perm:deny:abcde'), 'perm:deny:abcde')
})

test('buttons: collidesWithReserved flags only reserved shapes', () => {
  assert.equal(collidesWithReserved('__skip__'), true)
  assert.equal(collidesWithReserved('perm:once:abcde'), true)
  assert.equal(collidesWithReserved('sc:foo'), true)
  assert.equal(collidesWithReserved('u:already'), true)
  assert.equal(collidesWithReserved('normal-value'), false)
})

// ── 7. Machine-event meta (capability #12) ───────────────────────────────────

test('event: plain user message yields no event meta', () => {
  assert.equal(buildEventMeta('standard', null), null)
  assert.equal(buildEventMeta(null, null), null)
  assert.equal(buildEventMeta(undefined, undefined), null)
})

test('event: messageType="event" alone is recognized (source defaults to unknown)', () => {
  const frag = buildEventMeta('event', null)
  assert.deepEqual(frag, { event_type: 'event', event_source: 'unknown' })
})

test('event: eventMeta presence alone is recognized even without messageType', () => {
  const frag = buildEventMeta('standard', { source: 'n8n' })
  assert.deepEqual(frag, { event_type: 'event', event_source: 'n8n' })
})

test('event: full envelope maps source/title/peek/payload to flat fields', () => {
  const frag = buildEventMeta('event', {
    source: 'dashboard',
    title: 'Done - Luz Columna interview',
    peek: 'Kc marked this DONE',
    payload: { status: 'done', topThree: true },
  })
  assert.deepEqual(frag, {
    event_type: 'event',
    event_source: 'dashboard',
    event_title: 'Done - Luz Columna interview',
    event_peek: 'Kc marked this DONE',
    event_payload: { status: 'done', topThree: true },
  })
})

test('event: empty/whitespace string fields are dropped; payload null/undefined dropped', () => {
  const frag = buildEventMeta('event', {
    source: '   ',
    title: '',
    peek: '   ',
    payload: null,
  })
  // source falls back to "unknown"; the rest are dropped entirely.
  assert.deepEqual(frag, { event_type: 'event', event_source: 'unknown' })
})

test('event: falsy-but-valid payload (0, false, empty string) is preserved', () => {
  assert.equal(buildEventMeta('event', { payload: 0 })?.event_payload, 0)
  assert.equal(buildEventMeta('event', { payload: false })?.event_payload, false)
  assert.equal(buildEventMeta('event', { payload: '' })?.event_payload, '')
})
