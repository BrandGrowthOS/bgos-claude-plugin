import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildInboundChannel } from '../lib/inbound-channel.ts'
import { buildMeetingCard } from '../lib/meeting-card.ts'
import { buildInboundFilesMeta, type InboundFileLike } from '../lib/message-text.ts'

// The instructions promise agents a `files` meta value on every message that
// carries attachments. These tests hold both lanes to that promise and to the
// wake card contract: the harness silently drops a channel card whose meta
// carries ANY non-string value, so `files` must be a JSON string, never an
// array, and must be absent (not empty, not null) when there are none.

const SERVER_SOURCE = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

const COMMON = {
  chatId: 3582,
  messageId: 47820,
  userId: 'user_owner',
  assistantId: 901,
  timestamp: '2026-10-10T10:00:00.000Z',
  text: 'see attached',
}

const PHOTO_URL = 'https://s3.example/photo.jpg?sig=1'
const PDF_URL = 'https://s3.example/report.pdf?sig=2'

// The same attachments as each lane delivers them: the socket's
// inbound_message payload, and the poll's chat history row.
const WS_FILES: InboundFileLike[] = [
  { filename: 'photo.jpg', mime: 'image/jpeg', url: PHOTO_URL },
  { filename: 'report.pdf', mime: 'application/pdf', url: PDF_URL },
]
const POLL_FILES: InboundFileLike[] = [
  {
    fileName: 'photo.jpg', fileData: PHOTO_URL,
    fileMimeType: 'image/jpeg', isImage: true, isVideo: false, isDocument: false, isAudio: false,
  },
  {
    fileName: 'report.pdf', fileData: PDF_URL,
    fileMimeType: 'application/pdf', isImage: false, isVideo: false, isDocument: true, isAudio: false,
  },
]

const EXPECTED = [
  { name: 'photo.jpg', kind: 'image', mimeType: 'image/jpeg', url: PHOTO_URL },
  { name: 'report.pdf', kind: 'document', mimeType: 'application/pdf', url: PDF_URL },
]

function assertAllStrings(meta: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(meta)) {
    assert.equal(
      typeof v,
      'string',
      `meta.${k} must be a string (got ${Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v}); the harness drops the card otherwise`,
    )
  }
  // The instructions also promise every value INSIDE the files entries is a string.
  if (typeof meta.files === 'string') {
    for (const entry of JSON.parse(meta.files) as Array<Record<string, unknown>>) {
      for (const [k, v] of Object.entries(entry)) assert.equal(typeof v, 'string', `files[].${k}`)
    }
  }
}

// The stream lane hands buildInboundChannel the same two shapes (a poll row's
// messageFiles, or a live push's files), so it is held to the same promise.
const LANES = [
  { transport: 'ws', label: 'ws', files: WS_FILES },
  { transport: 'poll', label: 'poll', files: POLL_FILES },
  { transport: 'stream', label: 'stream (push shape)', files: WS_FILES },
  { transport: 'stream', label: 'stream (row shape)', files: POLL_FILES },
] as const

for (const lane of LANES) {
  for (const count of [0, 1, 2]) {
    const delivery = buildInboundChannel({
      ...COMMON,
      transport: lane.transport,
      files: lane.files.slice(0, count),
    })

    test(`${lane.label}, ${count} attachment(s): every meta value is a string (contract)`, () => {
      assertAllStrings(delivery.meta)
    })

    test(`${lane.label}, ${count} attachment(s): files meta present exactly when there are files`, () => {
      if (count === 0) {
        assert.equal('files' in delivery.meta, false, 'no attachments, so no files key at all')
        return
      }
      assert.equal('files' in delivery.meta, true, 'attachments, so the files key is set')
      assert.deepEqual(JSON.parse(delivery.meta.files), EXPECTED.slice(0, count))
    })

    test(`${lane.label}, ${count} attachment(s): content keeps one line per file`, () => {
      const lines = delivery.content.split('\n').filter((l) => l.startsWith('[Attached '))
      assert.equal(lines.length, count)
    })
  }
}

test('the socket and the poll build the same meta for the same message', () => {
  for (const count of [0, 1, 2]) {
    const ws = buildInboundChannel({ ...COMMON, transport: 'ws', files: WS_FILES.slice(0, count) })
    const poll = buildInboundChannel({ ...COMMON, transport: 'poll', files: POLL_FILES.slice(0, count) })
    const { transport: _w, ...wsRest } = ws.meta
    const { transport: _p, ...pollRest } = poll.meta
    assert.deepEqual(wsRest, pollRest, `count ${count}`)
    assert.equal(ws.content, poll.content, `count ${count}`)
  }
})

test('an inline file has no url in meta and keeps its data in the content line', () => {
  const dataUri = 'data:image/png;base64,iVBORw0KGgo='
  const delivery = buildInboundChannel({
    ...COMMON,
    transport: 'ws',
    files: [{ filename: 'dot.png', mime: 'image/png', dataUri }],
  })
  assertAllStrings(delivery.meta)
  assert.deepEqual(JSON.parse(delivery.meta.files), [{ name: 'dot.png', kind: 'image', mimeType: 'image/png' }])
  assert.match(delivery.content, /\[Attached image: dot\.png - data:image\/png;base64,/)
})

test('a poll row with raw base64 and no mime type has neither url nor mimeType in meta', () => {
  const delivery = buildInboundChannel({
    ...COMMON,
    transport: 'poll',
    files: [{ fileName: 'scan.png', fileData: 'iVBORw0KGgo=', isImage: true }],
  })
  assertAllStrings(delivery.meta)
  assert.deepEqual(JSON.parse(delivery.meta.files), [{ name: 'scan.png', kind: 'image' }])
  assert.match(delivery.content, /\[Attached image: scan\.png - iVBORw0KGgo=\]/)
})

test('a non http reference is not offered as a url', () => {
  const meta = buildInboundFilesMeta([{ filename: 'a.pdf', mime: 'application/pdf', url: 's3://bucket/a.pdf' }])
  assert.deepEqual(JSON.parse(meta as string), [{ name: 'a.pdf', kind: 'document', mimeType: 'application/pdf' }])
})

test('a size the server sends rides as a decimal string; anything else is left out', () => {
  const meta = buildInboundFilesMeta([
    { filename: 'a.pdf', mime: 'application/pdf', url: PDF_URL, size: 2048 },
    { fileName: 'b.png', fileData: PHOTO_URL, isImage: true, fileSize: '17' },
    { filename: 'c.pdf', mime: 'application/pdf', url: PDF_URL, size: -1 },
    { filename: 'd.pdf', mime: 'application/pdf', url: PDF_URL, size: 'lots' },
    { filename: 'e.pdf', mime: 'application/pdf', url: PDF_URL, size: 0 },
    { filename: 'f.pdf', mime: 'application/pdf', url: PDF_URL, size: '0x10' },
    { filename: 'g.pdf', mime: 'application/pdf', url: PDF_URL, size: 1.5 },
    { filename: 'h.pdf', mime: 'application/pdf', url: PDF_URL, size: ' ' },
    { filename: 'i.pdf', mime: 'application/pdf', url: PDF_URL, size: 'bad', fileSize: 9 },
  ])
  const sizes = (JSON.parse(meta as string) as Array<Record<string, string>>).map((e) => e.size)
  assert.deepEqual(sizes, ['2048', '17', undefined, undefined, '0', undefined, undefined, undefined, '9'])
})

// Meeting turn cards: the poll site passes the row's messageFiles, the socket
// twin its files, the broadcast whatever files it carries (none today).
const MEETING = {
  meetingId: 77,
  chatId: '3582',
  messageId: '47820',
  userId: 'user_owner',
  assistantId: '901',
  timestamp: '2026-10-10T10:00:00.000Z',
  yourTurn: true,
  participants: [],
  senderName: 'User',
  senderType: 'user' as const,
  text: 'see attached',
}

for (const lane of [
  { transport: 'ws', label: 'meeting twin', files: WS_FILES },
  { transport: 'poll', label: 'meeting poll', files: POLL_FILES },
]) {
  for (const count of [0, 1, 2]) {
    const card = buildMeetingCard({ ...MEETING, transport: lane.transport, files: lane.files.slice(0, count) })
    test(`${lane.label}, ${count} attachment(s): every meta value is a string (contract)`, () => {
      assertAllStrings(card.meta)
    })
    test(`${lane.label}, ${count} attachment(s): files meta present exactly when there are files`, () => {
      if (count === 0) {
        assert.equal('files' in card.meta, false)
      } else {
        assert.deepEqual(JSON.parse(card.meta.files), EXPECTED.slice(0, count))
      }
      assert.equal('files_unknown' in card.meta, false, 'twin and poll deliveries carry files')
      const lines = card.content.split('\n').filter((l) => l.startsWith('[Attached '))
      assert.deepEqual(lines, [
        `[Attached image: photo.jpg - ${PHOTO_URL}]`,
        `[Attached document: report.pdf - ${PDF_URL}]`,
      ].slice(0, count))
    })
  }
}

test('a meeting card from a delivery that cannot carry files says so', () => {
  const card = buildMeetingCard({ ...MEETING, transport: 'ws', files: [], filesUnknown: true })
  assertAllStrings(card.meta)
  assert.equal(card.meta.files_unknown, 'true')
  assert.equal('files' in card.meta, false)
  // The day the broadcast does carry files, the marker goes away.
  const withFiles = buildMeetingCard({ ...MEETING, transport: 'ws', files: WS_FILES, filesUnknown: true })
  assert.equal('files_unknown' in withFiles.meta, false)
})

test('a meeting card with a sized file keeps every meta value a string', () => {
  const card = buildMeetingCard({
    ...MEETING,
    transport: 'ws',
    files: [{ filename: 'a.pdf', mime: 'application/pdf', url: PDF_URL, size: 4096 }],
  })
  assertAllStrings(card.meta)
  assert.equal(JSON.parse(card.meta.files)[0].size, '4096')
})

test('every meeting card site in server.ts passes the turn files', () => {
  const sites = SERVER_SOURCE.split('buildMeetingCard({').slice(1).map((rest) => rest.slice(0, rest.indexOf('\n      })') + 1 || 2000))
  assert.equal(sites.length, 3, 'three meeting card sites')
  assert.ok(sites.some((x) => x.includes('files: msg.messageFiles ?? [],')), 'poll site')
  assert.ok(sites.some((x) => x.includes('files: wsFiles,')), 'socket twin site')
  assert.ok(sites.some((x) => x.includes('filesUnknown: !Array.isArray(payload?.files),')), 'broadcast site')
})

test('a meeting card with no files is exactly the card HEAD built', () => {
  // Pinned to the output of buildMeetingCard before files existed (main at
  // ce0ea22), so a no-files meeting turn cannot change by accident.
  const rest = { ...MEETING, transport: 'ws' }
  const before = {
    content: '[Meeting #77, your_turn=YES, participants: unknown]\nUser: see attached',
    meta: {
      chat_id: '3582',
      message_id: '47820',
      user: 'User',
      user_id: 'user_owner',
      assistant_id: '901',
      ts: '2026-10-10T10:00:00.000Z',
      event_type: 'meeting_message',
      meeting_id: '77',
      sender_type: 'user',
      sender_name: 'User',
      your_turn: 'YES',
      transport: 'ws',
    },
  }
  assert.deepEqual(buildMeetingCard(rest), before)
  assert.deepEqual(buildMeetingCard({ ...rest, files: [] }), before)
})

test('a file with no link is named on both lanes, not dropped, and marked unavailable', () => {
  for (const lane of [
    { transport: 'ws', files: [{ filename: 'lost.pdf', mime: 'application/pdf' }] },
    { transport: 'poll', files: [{ fileName: 'lost.pdf', fileData: '', fileMimeType: 'application/pdf', isDocument: true }] },
  ]) {
    const delivery = buildInboundChannel({ ...COMMON, transport: lane.transport, files: lane.files })
    assertAllStrings(delivery.meta)
    assert.deepEqual(
      JSON.parse(delivery.meta.files),
      [{ name: 'lost.pdf', kind: 'document', mimeType: 'application/pdf', unavailable: 'true' }],
      lane.transport,
    )
    assert.match(delivery.content, /\[Attached document: lost\.pdf - no link, the server could not provide one\]/)
  }
})

test('an empty url does not hide a real data uri, and a blank reference counts as none', () => {
  const d = buildInboundChannel({
    ...COMMON,
    transport: 'ws',
    files: [{ filename: 'd.png', mime: 'image/png', url: '', dataUri: 'data:image/png;base64,AAA' }],
  })
  assert.deepEqual(JSON.parse(d.meta.files), [{ name: 'd.png', kind: 'image', mimeType: 'image/png' }])
  assert.match(d.content, /\[Attached image: d\.png - data:image\/png;base64,AAA\]/)
  const blank = buildInboundChannel({
    ...COMMON,
    transport: 'poll',
    files: [{ fileName: 'x.png', fileData: '   ', isImage: true }],
  })
  assert.equal(JSON.parse(blank.meta.files)[0].unavailable, 'true')
  assert.match(blank.content, /\[Attached image: x\.png - no link, the server could not provide one\]/)
})

test('a poll row with no media flag set takes its kind from its mime type, as the socket does', () => {
  const ws = buildInboundFilesMeta([{ filename: 'p.png', mime: 'image/png', url: PHOTO_URL }])
  const poll = buildInboundFilesMeta([
    { fileName: 'p.png', fileData: PHOTO_URL, fileMimeType: 'image/png', isImage: null, isVideo: null, isAudio: null, isDocument: null },
  ])
  assert.equal(poll, ws)
  // A set flag still wins, as it always did.
  const flagged = buildInboundFilesMeta([{ fileName: 'x.bin', fileData: PHOTO_URL, fileMimeType: 'image/png', isDocument: true }])
  assert.equal(JSON.parse(flagged as string)[0].kind, 'document')
  // No flag and no mime is still a document.
  assert.equal(JSON.parse(buildInboundFilesMeta([{ fileName: 'y', fileData: PHOTO_URL }]) as string)[0].kind, 'document')
})

test('a poll row that carries null socket keys is still read as a poll row', () => {
  const meta = buildInboundFilesMeta([
    { fileName: 'photo.jpg', fileData: PHOTO_URL, fileMimeType: 'image/jpeg', isImage: true, url: null, mime: null, filename: null, dataUri: null },
  ])
  assert.deepEqual(JSON.parse(meta as string), [EXPECTED[0]])
})

test('the instructions describe the files meta exactly as it is sent', () => {
  const start = SERVER_SOURCE.indexOf("'## Receiving Attachments',")
  const end = SERVER_SOURCE.indexOf("'## SHARED-ASSISTANT CONTEXT", start)
  assert.ok(start > 0 && end > start, 'Receiving Attachments section found')
  // The prose the agent reads: the section's string literals, joined, with
  // the source's line wrapping collapsed to single spaces.
  const section = [...SERVER_SOURCE.slice(start, end).matchAll(/'((?:[^'\\]|\\.)*)',/g)]
    .map((m) => m[1].replace(/\\'/g, "'"))
    .join(' ')
    .replace(/\s+/g, ' ')
  for (const phrase of [
    '"[Attached <kind>: <name> - <ref>]"',
    '`meta.files`, a JSON STRING (not an array; parse it with JSON.parse)',
    'one object per file: `name`, `kind` (image/video/audio/document)',
    '`mimeType` (left out when the server sent none)',
    '`size` (bytes, left out when the server sent none, which today it never does)',
    '`url` (left out unless the reference is an http(s) link,',
    'Every value inside is a string.',
    'A file the server sent with neither a link nor inline data also has `unavailable` set to "true"',
    'reads "no link, the server could not provide one" in place of <ref>',
    '`meta.files` is absent when the message has no attachments.',
    'A meeting turn card (`meta.meeting_id` set) carries both the same way when its delivery carried the files.',
    'One built from the meeting broadcast, which carries no files yet, has neither and instead has `files_unknown = "true"`',
    'an absent `meta.files` does NOT mean the person attached nothing',
  ]) {
    assert.ok(section.includes(phrase), `instructions say: ${phrase}`)
  }
  // Every key the builder can emit is named, and no key it never emits.
  const full = JSON.parse(buildInboundFilesMeta([{ filename: 'a.pdf', mime: 'application/pdf', url: PDF_URL, size: 1 }]) as string)[0]
  assert.deepEqual(Object.keys(full).sort(), ['kind', 'mimeType', 'name', 'size', 'url'])
  const lost = JSON.parse(buildInboundFilesMeta([{ filename: 'b', mime: 'application/pdf' }]) as string)[0]
  for (const key of new Set([...Object.keys(full), ...Object.keys(lost)])) {
    assert.ok(section.includes('`' + key + '`'), key)
  }
  for (const stale of ['file_name', 'mime_type', '`type`', 'A `files` array']) {
    assert.equal(section.includes(stale), false, `stale shape word ${stale} is gone`)
  }
})
