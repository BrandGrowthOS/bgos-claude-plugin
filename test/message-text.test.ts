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
  MIME_MAP,
  DOC_MIMES,
  guessMimeType,
  guessOutboundMime,
  getFileCategory,
  unsupportedFileMessage,
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

test('inbound: WS file with a whitespace-only ref is skipped', () => {
  const content = buildInboundContent(' \n ', [
    { filename: 'empty.pdf', mime: 'application/pdf', url: '  \t ' },
  ])
  assert.equal(content, '')
})

test('inbound: poll file with no ref is skipped', () => {
  const content = buildInboundContent('', [
    { isDocument: true, fileName: 'empty.pdf', fileData: '' },
  ])
  assert.equal(content, '')
})

test('inbound: poll file with a whitespace-only ref is skipped', () => {
  const content = buildInboundContent('\t', [
    { isDocument: true, fileName: 'empty.pdf', fileData: '  \n ' },
  ])
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

test('inbound: backlog framing cannot turn blank content into a delivery', () => {
  assert.equal(
    buildInboundContent(' \n\t ', [], {
      backlogPrefix: '[backlog - message arrived while you were offline; please respond]',
    }),
    '',
  )
})

test('inbound: a valid attachment makes a blank body deliverable', () => {
  assert.equal(
    buildInboundContent(' \n ', [
      { isImage: true, fileName: 'proof.png', fileData: 'https://cdn/proof.png' },
    ]),
    '[Attached image: proof.png - https://cdn/proof.png]',
  )
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

// Backend PR #783 widened the inbound allowlist (backend
// file-validation.utils.ts) to archives, markdown, and common text formats.
// The plugin's outbound path must accept the same set so an agent can SEND
// every type the backend accepts. Each entry maps a NAMED extension to the
// exact concrete MIME the backend allowlists.
test('mime: post-783 outbound extensions map to backend-accepted concrete types', () => {
  const expected: Record<string, string> = {
    // Markdown
    'notes.md': 'text/markdown',
    'notes.markdown': 'text/markdown',
    // Archives (opaque blobs, never extracted)
    'bundle.rar': 'application/vnd.rar',
    'bundle.7z': 'application/x-7z-compressed',
    'bundle.tar': 'application/x-tar',
    'bundle.gz': 'application/gzip',
    'bundle.tgz': 'application/gzip',
    // Structured / rich-text documents
    'data.xml': 'application/xml',
    'doc.rtf': 'application/rtf',
    'book.epub': 'application/epub+zip',
    // Plain-text code/config
    'app.js': 'text/javascript',
    'app.ts': 'text/typescript',
    'app.py': 'text/x-python',
    'page.html': 'text/html',
    'page.htm': 'text/html',
    'style.css': 'text/css',
    'conf.toml': 'application/toml',
    'run.log': 'text/plain',
  }
  for (const [name, mime] of Object.entries(expected)) {
    assert.equal(guessMimeType(name), mime, `guessMimeType(${name})`)
    assert.equal(getFileCategory(mime), 'document', `category of ${mime}`)
  }
})

test('mime: DOC_MIMES mirrors the full backend document allowlist', () => {
  // Snapshot of ALLOWED_MIMES.document from BGOS backend
  // src/common/file-validation.utils.ts as of PR #783. If the backend widens
  // again, add here AND in lib/message-text.ts.
  const backendDocumentMimes = [
    'application/pdf', 'text/plain', 'text/csv', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/json',
    'application/zip', 'application/x-zip-compressed',
    'application/vnd.rar', 'application/x-rar-compressed', 'application/x-rar',
    'application/x-7z-compressed', 'application/x-tar',
    'application/gzip', 'application/x-gzip',
    'text/yaml', 'application/x-yaml', 'application/yaml', 'text/x-yaml',
    'text/markdown', 'text/x-markdown',
    'application/xml', 'text/xml',
    'application/rtf', 'text/rtf',
    'application/epub+zip',
    'text/javascript', 'application/javascript',
    'text/typescript', 'application/typescript',
    'text/x-python', 'text/x-python-script',
    'text/html', 'text/css',
    'application/toml', 'text/toml',
  ]
  for (const mime of backendDocumentMimes) {
    assert.ok(DOC_MIMES.has(mime), `DOC_MIMES is missing ${mime}`)
    assert.equal(getFileCategory(mime), 'document', `category of ${mime}`)
  }
  // Bidirectional: the plugin must not accept a document MIME the backend
  // would 400 on.
  assert.equal(DOC_MIMES.size, backendDocumentMimes.length,
    'DOC_MIMES has entries beyond the backend allowlist')
})

test('mime: guessOutboundMime prefers explicit, then path, then file_name', () => {
  assert.equal(guessOutboundMime('/tmp/a.md', 'a.md', 'text/x-markdown'), 'text/x-markdown')
  assert.equal(guessOutboundMime('/tmp/notes.md', 'notes.md'), 'text/markdown')
  // Download-style temp path with a meaningful display name: the file_name
  // extension must rescue the guess instead of producing a wrong rejection.
  assert.equal(guessOutboundMime('/tmp/download.tmp', 'notes.md'), 'text/markdown')
  assert.equal(guessOutboundMime('/tmp/blob.bin', 'blob.bin'), null)
})

test('mime: still-disallowed types stay rejected', () => {
  assert.equal(guessMimeType('setup.exe'), null)
  assert.equal(guessMimeType('lib.dll'), null)
  assert.equal(guessMimeType('image.dmg'), null)
  assert.equal(getFileCategory('application/x-msdownload'), null)
  assert.equal(getFileCategory('application/octet-stream'), null)
})

// Regression guard: outbound MIME tables must stay concrete. A wildcard entry
// (for example 'application/*') would silently widen the outbound allowlist
// past what the backend accepts.
test('mime: every MIME_MAP and DOC_MIMES entry is a concrete type/subtype string', () => {
  const concrete = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/
  for (const [ext, mime] of Object.entries(MIME_MAP)) {
    assert.equal(typeof mime, 'string', `MIME_MAP[${ext}]`)
    assert.ok(!mime.includes('*'), `MIME_MAP[${ext}] contains a wildcard: ${mime}`)
    assert.match(mime, concrete, `MIME_MAP[${ext}] is not a concrete MIME: ${mime}`)
    assert.match(ext, /^\.[a-z0-9]+$/, `MIME_MAP key is not a plain extension: ${ext}`)
  }
  for (const mime of DOC_MIMES) {
    assert.ok(!mime.includes('*'), `DOC_MIMES contains a wildcard: ${mime}`)
    assert.match(mime, concrete, `DOC_MIMES entry is not a concrete MIME: ${mime}`)
  }
})

// Every extension in MIME_MAP must resolve to a category, otherwise resolveFile
// guesses a MIME it then rejects (a confusing "unsupported" for a mapped type).
test('mime: every MIME_MAP entry resolves to a file category', () => {
  for (const [ext, mime] of Object.entries(MIME_MAP)) {
    assert.notEqual(getFileCategory(mime), null, `${ext} maps to uncategorised ${mime}`)
  }
})

test('mime: unsupportedFileMessage names the extension and the allowed set', () => {
  const msg = unsupportedFileMessage('setup.exe', 'application/x-msdownload')
  assert.ok(msg.includes('.exe'), 'names the extension')
  assert.ok(msg.includes('application/x-msdownload'), 'names the mime')
  assert.ok(/pdf/i.test(msg), 'mentions documents')
  assert.ok(/zip/i.test(msg), 'mentions archives')
  assert.ok(/\bmd\b/i.test(msg), 'mentions markdown')
  const noExt = unsupportedFileMessage('Makefile', null)
  assert.ok(noExt.includes('Makefile'), 'falls back to the file name when no extension')
  assert.ok(/pdf/i.test(noExt), 'still lists the allowed set')
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
    event_payload: '{"status":"done","topThree":true}',
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

test('event: falsy-but-valid payload (0, false, empty string) is preserved AS A STRING', () => {
  // Non-strings are JSON-serialized; a raw 0/false in meta would make the
  // harness drop the whole card (the msg-23050/23080 regression).
  assert.equal(buildEventMeta('event', { payload: 0 })?.event_payload, '0')
  assert.equal(buildEventMeta('event', { payload: false })?.event_payload, 'false')
  assert.equal(buildEventMeta('event', { payload: '' })?.event_payload, '')
})

test('event: EVERY meta value is a string, even for a deeply nested payload (harness drop guard)', () => {
  // Mirrors the real meeting-summary shape that silently vanished for Mark
  // (msgs 23050/23080): nested objects, arrays, booleans, nulls.
  const frag = buildEventMeta('event', {
    source: 'n8n',
    title: 'Meeting summary',
    peek: 'Sandwich launch strategy...',
    payload: {
      date: '2026-07-07',
      action_items: [{ due: null, what: 'Upload assets', owner: 'Zara' }],
      kc_marketing_relevant: true,
    },
  })
  assert.ok(frag)
  for (const [k, v] of Object.entries(frag!)) {
    assert.equal(typeof v, 'string', `meta.${k} must be a string, got ${typeof v}`)
  }
  // And the payload round-trips for the agent.
  const parsed = JSON.parse(frag!.event_payload!)
  assert.equal(parsed.kc_marketing_relevant, true)
  assert.equal(parsed.action_items[0].owner, 'Zara')
})
