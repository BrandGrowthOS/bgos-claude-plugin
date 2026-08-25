/**
 * The silent liveness probe (zero-terminal lifecycle, design 7.2): after the
 * watcher restarts an agent, nothing proves the new session HEARS the
 * channel until the user speaks, because the live marker only refreshes on
 * the first tool call of a boot and the boot hello only fires once per
 * pairing. So the watcher drops ~/.bgos-agent/<id>/probe-requested.json,
 * the daemon polls it, pushes one silent channel notification asking for
 * the `channel_ack` tool, and that call flips liveness + touches
 * channel-live.json, which the watcher reads as proof.
 *
 * Pure pieces are tested directly; the server.ts wiring is pinned textually
 * (server.ts cannot be imported: it exits without credentials at module
 * load, see stream-wiring.test.ts for the convention).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  LIVENESS_PROBE_MIN_INTERVAL_MS,
  LIVENESS_PROBE_POLL_MS,
  PROBE_REQUEST_FILE,
  buildLivenessProbeNotification,
  probeRequestPath,
  shouldSendLivenessProbe,
} from '../lib/boot-hello.ts'

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

// ── Pure pieces ──────────────────────────────────────────────────────────────

test('probeRequestPath lives in the launcher state dir, never the plugin state dir', () => {
  assert.equal(probeRequestPath('/home/x', '871'), join('/home/x', '.bgos-agent', '871', PROBE_REQUEST_FILE))
  assert.equal(probeRequestPath('/home/x', 871), join('/home/x', '.bgos-agent', '871', PROBE_REQUEST_FILE))
  assert.equal(PROBE_REQUEST_FILE, 'probe-requested.json')
  // An invalid id builds no path (mirror of update-readiness validAssistantId).
  assert.equal(probeRequestPath('/home/x', 'nope'), null)
  assert.equal(probeRequestPath('/home/x', ''), null)
  assert.equal(probeRequestPath('/home/x', null), null)
})

test('shouldSendLivenessProbe: only when the file exists, at most once per 30s', () => {
  assert.equal(LIVENESS_PROBE_MIN_INTERVAL_MS, 30_000)
  assert.equal(LIVENESS_PROBE_POLL_MS, 3_000)
  const now = 1_000_000
  assert.equal(shouldSendLivenessProbe({ markerExists: false, lastSentAt: null, now }), false)
  assert.equal(shouldSendLivenessProbe({ markerExists: true, lastSentAt: null, now }), true)
  assert.equal(shouldSendLivenessProbe({ markerExists: true, lastSentAt: now - 29_999, now }), false)
  assert.equal(shouldSendLivenessProbe({ markerExists: true, lastSentAt: now - 30_000, now }), true)
  assert.equal(shouldSendLivenessProbe({ markerExists: true, lastSentAt: now, now }), false)
  assert.equal(shouldSendLivenessProbe({ markerExists: false, lastSentAt: now - 60_000, now }), false)
})

test('buildLivenessProbeNotification: names the tool, forbids user-facing output, carries the event type', () => {
  const probe = buildLivenessProbeNotification()
  assert.equal(
    probe.content,
    '[hoai] Liveness check after a restart. Call the channel_ack tool now, ' +
      'then continue whatever you were doing. Do NOT send any message to the user for this.',
  )
  assert.deepEqual(probe.meta, { event_type: 'liveness_probe' })
  const withChat = buildLivenessProbeNotification({ chatId: '42' })
  assert.deepEqual(withChat.meta, { event_type: 'liveness_probe', chat_id: '42' })
  assert.deepEqual(buildLivenessProbeNotification({ chatId: '  ' }).meta, { event_type: 'liveness_probe' })
  assert.deepEqual(buildLivenessProbeNotification({ chatId: null }).meta, { event_type: 'liveness_probe' })
  // No em or en dashes anywhere in agent-facing copy (repo rule).
  assert.ok(!/[\u2013\u2014]/.test(probe.content))
})

// ── server.ts wiring pins ────────────────────────────────────────────────────

test('server.ts declares the channel_ack tool: internal, no input, says it sends nothing to the user', () => {
  const idx = serverSource.indexOf("name: 'channel_ack'")
  assert.notEqual(idx, -1, 'channel_ack must be declared in the ListTools catalog')
  const decl = serverSource.slice(idx, idx + 900)
  assert.ok(decl.includes('Liveness acknowledgement after a restart'), decl)
  assert.ok(decl.includes('Sends nothing to the user'), decl)
  assert.match(decl, /properties:\s*\{\s*\}/, 'channel_ack takes no arguments')
  // Declared inside the ListTools handler, not somewhere else by accident.
  const listTools = serverSource.indexOf('mcp.setRequestHandler(ListToolsRequestSchema')
  const callTool = serverSource.indexOf('mcp.setRequestHandler(CallToolRequestSchema')
  assert.ok(listTools < idx && idx < callTool)
})

test('the channel_ack handler marks liveness, records the marker, answers ok, and runs before the drain gate', () => {
  const callTool = serverSource.slice(serverSource.indexOf('mcp.setRequestHandler(CallToolRequestSchema'))
  const ack = callTool.indexOf("req.params.name === 'channel_ack'")
  assert.notEqual(ack, -1, 'channel_ack needs a dedicated branch in the CallTool chokepoint')
  const body = callTool.slice(ack, ack + 700)
  assert.ok(body.includes('channelLiveness.markToolCall()'), body)
  assert.ok(body.includes('recordLiveMarker(LIVE_MARKER_PATH'), body)
  assert.ok(body.includes("text: 'ok'"), body)
  const drainGate = callTool.indexOf('if (updateDrainMode) {')
  assert.ok(drainGate !== -1 && ack < drainGate, 'the ack must answer even while an update drains intake')
  const tracked = callTool.indexOf('return trackMessageOperation(')
  assert.ok(tracked !== -1 && ack < tracked, 'the ack is not a tracked message operation (it must never block a drain)')
})

test('the probe poll: a 3s unref timer that rate-limits, unlinks the file, and pushes one channel notification', () => {
  const start = serverSource.indexOf('// Step 2.6: liveness probe')
  assert.notEqual(start, -1, 'the probe poll block must be labelled Step 2.6')
  const end = serverSource.indexOf('// Step 2.7:', start)
  assert.notEqual(end, -1)
  const block = serverSource.slice(start, end)
  assert.ok(block.includes('probeRequestPath(homedir(), ASSISTANT_ID)'), block)
  assert.ok(block.includes('LIVENESS_PROBE_POLL_MS'), block)
  assert.ok(block.includes('.unref()'), block)
  assert.ok(block.includes('shouldSendLivenessProbe({'), block)
  assert.ok(block.includes('unlinkSync(PROBE_REQUEST_PATH)'), block)
  assert.ok(block.includes('buildLivenessProbeNotification('), block)
  assert.ok(block.includes("method: 'notifications/claude/channel'"), block)
  // The unlink happens BEFORE the push: a failed push must not loop forever
  // on the same file, the watcher rewrites it every 30s anyway.
  assert.ok(block.indexOf('unlinkSync(PROBE_REQUEST_PATH)') < block.indexOf('buildLivenessProbeNotification('))
})
