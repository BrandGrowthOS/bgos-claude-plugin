import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildInboundChannel } from '../lib/inbound-channel.ts'
import { buildInboundFilesMeta } from '../lib/message-text.ts'

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
const WS_FILES = [
  { id: 1, filename: 'photo.jpg', mime: 'image/jpeg', url: PHOTO_URL },
  { id: 2, filename: 'report.pdf', mime: 'application/pdf', url: PDF_URL },
]
const POLL_FILES = [
  {
    id: 1, messageId: 47820, fileName: 'photo.jpg', fileData: PHOTO_URL,
    fileMimeType: 'image/jpeg', isImage: true, isVideo: false, isDocument: false, isAudio: false,
  },
  {
    id: 2, messageId: 47820, fileName: 'report.pdf', fileData: PDF_URL,
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
      files: lane.files.slice(0, count) as never[],
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
    const ws = buildInboundChannel({ ...COMMON, transport: 'ws', files: WS_FILES.slice(0, count) as never[] })
    const poll = buildInboundChannel({ ...COMMON, transport: 'poll', files: POLL_FILES.slice(0, count) as never[] })
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
    files: [{ filename: 'dot.png', mime: 'image/png', dataUri }] as never[],
  })
  assertAllStrings(delivery.meta)
  assert.deepEqual(JSON.parse(delivery.meta.files), [{ name: 'dot.png', kind: 'image', mimeType: 'image/png' }])
  assert.match(delivery.content, /\[Attached image: dot\.png - data:image\/png;base64,/)
})

test('a poll row with raw base64 and no mime type has neither url nor mimeType in meta', () => {
  const delivery = buildInboundChannel({
    ...COMMON,
    transport: 'poll',
    files: [{ fileName: 'scan.png', fileData: 'iVBORw0KGgo=', isImage: true }] as never[],
  })
  assertAllStrings(delivery.meta)
  assert.deepEqual(JSON.parse(delivery.meta.files), [{ name: 'scan.png', kind: 'image' }])
  assert.match(delivery.content, /\[Attached image: scan\.png - iVBORw0KGgo=\]/)
})

test('a non http reference is not offered as a url', () => {
  const meta = buildInboundFilesMeta([{ filename: 'a.pdf', mime: 'application/pdf', url: 's3://bucket/a.pdf' }])
  assert.deepEqual(JSON.parse(meta as string), [{ name: 'a.pdf', kind: 'document', mimeType: 'application/pdf' }])
})

test('a socket file with no link is skipped in both the content and the meta', () => {
  assert.equal(buildInboundFilesMeta([{ filename: 'lost.pdf', mime: 'application/pdf' }]), null)
  const delivery = buildInboundChannel({
    ...COMMON,
    transport: 'ws',
    files: [{ filename: 'lost.pdf', mime: 'application/pdf' }] as never[],
  })
  assert.equal('files' in delivery.meta, false)
  assert.doesNotMatch(delivery.content, /Attached/)
})

test('the instructions describe the files meta exactly as it is sent', () => {
  const start = SERVER_SOURCE.indexOf("'## Receiving Attachments',")
  const end = SERVER_SOURCE.indexOf("'## SHARED-ASSISTANT CONTEXT", start)
  assert.ok(start > 0 && end > start, 'Receiving Attachments section found')
  const section = SERVER_SOURCE.slice(start, end)
  assert.match(section, /`meta\.files`, a JSON STRING \(not an array; parse it with JSON\.parse\)/)
  assert.match(section, /`meta\.files` is absent when the message has no attachments\./)
  assert.match(section, /"\[Attached <kind>: <name> - <ref>\]"/)
  assert.match(section, /`mimeType` \(left out when the server sent/)
  assert.match(section, /`url` \(left out unless the reference is an http\(s\) link,/)
  assert.match(section, /Every value inside is a string\./)
  // Every key the builder can emit is named, and no key it never emits.
  for (const key of Object.keys(EXPECTED[0])) assert.match(section, new RegExp('`' + key + '`'))
  for (const stale of ['file_name', 'mime_type', '`type`', 'A `files` array']) {
    assert.equal(section.includes(stale), false, `stale shape word ${stale} is gone`)
  }
})
