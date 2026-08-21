// Fix 09: boot hello + persistent channel-live marker. The preflight's
// Connected row cannot prove the session HEARS channel events (the Vulcan
// E2E, 2026-08-22: --channels loaded tools, said Connected, wired nothing).
// The hello manufactures positive proof: one notification on the first-ever
// boot, the agent's reply flips liveness, the marker records it, and the
// bootstrap waits for the marker before claiming success.
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LIVE_MARKER_FILE,
  liveMarkerPath,
  parseLiveMarker,
  nextLiveMarker,
  shouldSendBootHello,
  buildBootHelloNotification,
  readLiveMarker,
  recordLiveMarker,
  liveMarkerMtimeMs,
} from '../lib/boot-hello.ts'

test('liveMarkerPath sits inside the per-assistant state dir', () => {
  assert.equal(
    liveMarkerPath('C:\\Users\\x\\.bgos-plugin-state\\1032'),
    join('C:\\Users\\x\\.bgos-plugin-state\\1032', LIVE_MARKER_FILE),
  )
})

test('parseLiveMarker: junk, absent, and partial shapes', () => {
  assert.equal(parseLiveMarker(null), null)
  assert.equal(parseLiveMarker('not json'), null)
  assert.equal(parseLiveMarker('{}'), null)
  assert.deepEqual(parseLiveMarker('{"firstLiveAt":"A","lastLiveAt":"B"}'), {
    firstLiveAt: 'A',
    lastLiveAt: 'B',
  })
  // A partial file still resolves both fields (one side fills the other).
  assert.deepEqual(parseLiveMarker('{"lastLiveAt":"B"}'), {
    firstLiveAt: 'B',
    lastLiveAt: 'B',
  })
})

test('nextLiveMarker preserves the first-live time and advances the last', () => {
  assert.deepEqual(nextLiveMarker(null, 'T1'), { firstLiveAt: 'T1', lastLiveAt: 'T1' })
  assert.deepEqual(nextLiveMarker({ firstLiveAt: 'T1', lastLiveAt: 'T1' }, 'T2'), {
    firstLiveAt: 'T1',
    lastLiveAt: 'T2',
  })
})

test('shouldSendBootHello: only the never-proven pairing, once per boot, killable', () => {
  assert.equal(shouldSendBootHello({ markerExists: false, sentThisBoot: false }), true)
  assert.equal(shouldSendBootHello({ markerExists: true, sentThisBoot: false }), false)
  assert.equal(shouldSendBootHello({ markerExists: false, sentThisBoot: true }), false)
  assert.equal(
    shouldSendBootHello({ markerExists: false, sentThisBoot: false, killSwitch: 'off' }),
    false,
  )
  assert.equal(
    shouldSendBootHello({ markerExists: false, sentThisBoot: false, killSwitch: 'on' }),
    true,
  )
})

test('buildBootHelloNotification names the reply tool and the chat', () => {
  const built = buildBootHelloNotification({ assistantName: 'Vulcan', chatId: '4291' })
  assert.match(built.content, /reply/)
  assert.match(built.content, /chat_id=4291/)
  assert.match(built.content, /Vulcan/)
  assert.match(built.content, /hello/)
  assert.equal(built.meta.event_type, 'boot_hello')
  assert.equal(built.meta.chat_id, '4291')
  const anonymous = buildBootHelloNotification({ chatId: '7' })
  assert.match(anonymous.content, /online for the first time/)
})

test('record + read round-trip on a real temp dir, mtime observable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boot-hello-'))
  try {
    const path = liveMarkerPath(join(dir, 'deep', 'state'))
    assert.equal(readLiveMarker(path), null)
    assert.equal(liveMarkerMtimeMs(path), null)
    recordLiveMarker(path, '2026-08-22T00:00:00.000Z')
    assert.deepEqual(readLiveMarker(path), {
      firstLiveAt: '2026-08-22T00:00:00.000Z',
      lastLiveAt: '2026-08-22T00:00:00.000Z',
    })
    recordLiveMarker(path, '2026-08-22T01:00:00.000Z')
    assert.deepEqual(readLiveMarker(path), {
      firstLiveAt: '2026-08-22T00:00:00.000Z',
      lastLiveAt: '2026-08-22T01:00:00.000Z',
    })
    assert.ok((liveMarkerMtimeMs(path) ?? 0) > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('recordLiveMarker never throws on an unwritable path', () => {
  // A path that cannot be a directory parent (NUL device on win32, /dev/null
  // elsewhere) must be swallowed: telemetry never crashes the daemon.
  const bad = process.platform === 'win32' ? 'NUL\\x\\y.json' : '/dev/null/x/y.json'
  recordLiveMarker(bad, '2026-08-22T00:00:00.000Z')
  assert.ok(true)
})
