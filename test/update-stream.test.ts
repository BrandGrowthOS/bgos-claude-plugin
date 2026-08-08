import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BEACON_INTERVAL_MS,
  GAP_BUFFER_MS,
  UpdateStreamConsumer,
  beaconWatchdog,
  decideStamped,
  sweepMode,
  type FetchResult,
} from '../lib/update-stream.ts';

/**
 * The Agent Update Stream consumer (agent-message-routing.md 5.2, 5.4,
 * 5.7, 8), the daemon half. Pure state machine, injected IO.
 *
 * The plugin-side kill-switch invariant lives here too: losing stream
 * authority or beacons DEGRADES to the legacy sweep cadence; it must
 * never become a reconnect loop (9.1, fourth finding).
 */

// ---------------------------------------------------------------------------
// 5.2 arithmetic
// ---------------------------------------------------------------------------

test('seq == local + 1 applies', () => {
  assert.deepEqual(decideStamped(10, 3, 11, 3), { action: 'apply' });
});

test('seq <= local is a duplicate, dropped by arithmetic not by hope', () => {
  assert.deepEqual(decideStamped(10, 3, 10, 3), { action: 'duplicate' });
  assert.deepEqual(decideStamped(10, 3, 4, 3), { action: 'duplicate' });
});

test('seq > local + 1 is a possible gap', () => {
  assert.deepEqual(decideStamped(10, 3, 12, 3), { action: 'gap' });
});

test('an epoch mismatch forces a full resync before any arithmetic', () => {
  assert.deepEqual(decideStamped(10, 3, 11, 4), { action: 'epoch_resync' });
});

// ---------------------------------------------------------------------------
// Consumer harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  fetchScript?: FetchResult[];
  fullResyncResult?: { state: number; epoch: number } | null;
}

function harness(opts: HarnessOptions = {}) {
  const applied: number[] = [];
  const persisted: Array<{ seq: number; epoch: number }> = [];
  const fetchCalls: Array<{ since: number }> = [];
  const sleeps: number[] = [];
  let resyncs = 0;
  const script = [...(opts.fetchScript ?? [])];

  const consumer = new UpdateStreamConsumer({
    initialCursor: { seq: 10, epoch: 3 },
    deps: {
      fetchUpdates: async (since) => {
        fetchCalls.push({ since });
        const next = script.shift();
        if (!next) return { kind: 'ok', updates: [], state: since, final: true, streamEpoch: 3 };
        return next;
      },
      applyUpdate: async (u) => {
        applied.push(u.seq);
      },
      persistCursor: (c) => {
        persisted.push({ ...c });
      },
      fullResync: async () => {
        resyncs += 1;
        return opts.fullResyncResult === undefined
          ? { state: 50, epoch: 4 }
          : opts.fullResyncResult;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      jitterMs: () => 0,
    },
  });
  return { consumer, applied, persisted, fetchCalls, sleeps, resyncCount: () => resyncs };
}

const upd = (seq: number) => ({
  seq,
  kind: 'message_new',
  chatId: 1,
  messageId: seq,
  payload: {},
});

// ---------------------------------------------------------------------------
// Live events: apply, dup, buffer-drain, deadline
// ---------------------------------------------------------------------------

test('a live successor applies and advances the cursor after handoff', async () => {
  const h = harness();
  const decision = await h.consumer.onStampedEvent(
    { seq: 11, streamEpoch: 3 },
    async () => h.applied.push(11),
    1_000,
  );
  assert.equal(decision, 'applied');
  assert.deepEqual(h.applied, [11]);
  assert.equal(h.consumer.cursor.seq, 11);
});

test('a reordered pair drains from the buffer in order with no catch-up call', async () => {
  const h = harness();
  // seq 12 arrives before 11 (commit reorder): buffered, not applied.
  const first = await h.consumer.onStampedEvent(
    { seq: 12, streamEpoch: 3 },
    async () => h.applied.push(12),
    1_000,
  );
  assert.equal(first, 'buffered');
  assert.deepEqual(h.applied, []);
  // 11 lands: applies, then the buffer drains 12 immediately.
  await h.consumer.onStampedEvent(
    { seq: 11, streamEpoch: 3 },
    async () => h.applied.push(11),
    1_100,
  );
  assert.deepEqual(h.applied, [11, 12]);
  assert.equal(h.consumer.cursor.seq, 12);
  assert.equal(h.fetchCalls.length, 0);
});

test('an unfilled gap past the 500ms deadline becomes ONE catch-up call', async () => {
  const h = harness({
    fetchScript: [
      { kind: 'ok', updates: [upd(11), upd(12)], state: 12, final: true, streamEpoch: 3 },
    ],
  });
  await h.consumer.onStampedEvent(
    { seq: 12, streamEpoch: 3 },
    async () => h.applied.push(12),
    1_000,
  );
  await h.consumer.checkDeadlines(1_000 + GAP_BUFFER_MS + 1);
  assert.equal(h.fetchCalls.length, 1);
  assert.deepEqual(h.fetchCalls[0], { since: 10 });
  // Both missed updates applied through the difference, in order.
  assert.deepEqual(h.applied, [11, 12]);
  assert.equal(h.consumer.cursor.seq, 12);
});

test('a failed handoff pins the cursor for redelivery (5.7)', async () => {
  const h = harness();
  await assert.rejects(
    h.consumer.onStampedEvent(
      { seq: 11, streamEpoch: 3 },
      async () => {
        throw new Error('harness backpressure');
      },
      1_000,
    ),
  );
  assert.equal(h.consumer.cursor.seq, 10);
});

// ---------------------------------------------------------------------------
// The chain: slices, intermediate persistence, single flight
// ---------------------------------------------------------------------------

test('a sliced difference persists the intermediate cursor BEFORE the next request', async () => {
  const h = harness({
    fetchScript: [
      { kind: 'ok', updates: [upd(11)], state: 11, final: false, streamEpoch: 3 },
      { kind: 'ok', updates: [upd(12)], state: 12, final: true, streamEpoch: 3 },
    ],
  });
  await h.consumer.runCatchup('test', 1_000);
  assert.deepEqual(h.fetchCalls, [{ since: 10 }, { since: 11 }]);
  // The intermediate cursor (11) was persisted before the second fetch.
  assert.ok(h.persisted.some((c) => c.seq === 11));
  assert.equal(h.consumer.cursor.seq, 12);
});

test('live pushes during a chain are ignored and trigger ONE extra round', async () => {
  const h = harness({
    fetchScript: [
      { kind: 'ok', updates: [upd(11)], state: 11, final: true, streamEpoch: 3 },
      { kind: 'ok', updates: [upd(12)], state: 12, final: true, streamEpoch: 3 },
    ],
  });
  const chain = h.consumer.runCatchup('test', 1_000);
  const decision = await h.consumer.onStampedEvent(
    { seq: 12, streamEpoch: 3 },
    async () => h.applied.push(999),
    1_001,
  );
  assert.equal(decision, 'in_difference');
  await chain;
  // The push was NOT applied live (999 absent); the extra round fetched it.
  assert.deepEqual(h.applied, [11, 12]);
  assert.equal(h.fetchCalls.length, 2);
});

test('a second runCatchup during a chain sets redo instead of a parallel chain', async () => {
  const h = harness({
    fetchScript: [
      { kind: 'ok', updates: [upd(11)], state: 11, final: true, streamEpoch: 3 },
      { kind: 'ok', updates: [], state: 11, final: true, streamEpoch: 3 },
    ],
  });
  const first = h.consumer.runCatchup('a', 1_000);
  const second = h.consumer.runCatchup('b', 1_001);
  await Promise.all([first, second]);
  // Two rounds total (the redo), never two interleaved chains: the fetch
  // origins are strictly sequential cursors.
  assert.deepEqual(h.fetchCalls, [{ since: 10 }, { since: 11 }]);
});

// ---------------------------------------------------------------------------
// tooOld / invalidCursor / epoch / 429 / 404
// ---------------------------------------------------------------------------

test('tooOld routes to ONE full resync and adopts its state and epoch', async () => {
  const h = harness({
    fetchScript: [{ kind: 'too_old', state: 90, streamEpoch: 3 }],
  });
  await h.consumer.runCatchup('test', 1_000);
  assert.equal(h.resyncCount(), 1);
  assert.deepEqual(h.consumer.cursor, { seq: 50, epoch: 4 });
});

test('invalidCursor (a cursor from the future) resyncs identically', async () => {
  const h = harness({
    fetchScript: [{ kind: 'invalid_cursor', state: 5, streamEpoch: 3 }],
  });
  await h.consumer.runCatchup('test', 1_000);
  assert.equal(h.resyncCount(), 1);
});

test('an epoch change in the difference response resyncs (unlogged window)', async () => {
  const h = harness({
    fetchScript: [
      { kind: 'ok', updates: [], state: 10, final: true, streamEpoch: 7 },
    ],
  });
  await h.consumer.runCatchup('test', 1_000);
  assert.equal(h.resyncCount(), 1);
});

test('429 mid-chain waits Retry-After and resumes from the intermediate cursor', async () => {
  const h = harness({
    fetchScript: [
      { kind: 'ok', updates: [upd(11)], state: 11, final: false, streamEpoch: 3 },
      { kind: 'rate_limited', retryAfterSeconds: 7 },
      { kind: 'ok', updates: [upd(12)], state: 12, final: true, streamEpoch: 3 },
    ],
  });
  await h.consumer.runCatchup('test', 1_000);
  assert.deepEqual(h.sleeps, [7_000]);
  // Resumed from 11, never restarted from the original since=10.
  assert.deepEqual(h.fetchCalls, [{ since: 10 }, { since: 11 }, { since: 11 }]);
  assert.equal(h.consumer.cursor.seq, 12);
});

test('404 means old backend: the chain reports feature-absent and touches nothing', async () => {
  const h = harness({ fetchScript: [{ kind: 'not_found' }] });
  const outcome = await h.consumer.runCatchup('test', 1_000);
  assert.equal(outcome, 'feature_absent');
  assert.equal(h.consumer.cursor.seq, 10);
  assert.equal(h.resyncCount(), 0);
});

test('a fetch that throws leaves the chain re-runnable (finally clears the flag)', async () => {
  const h = harness();
  let threw = false;
  const consumer = new UpdateStreamConsumer({
    initialCursor: { seq: 10, epoch: 3 },
    deps: {
      fetchUpdates: async () => {
        if (!threw) {
          threw = true;
          throw new Error('socket died mid-slice');
        }
        return { kind: 'ok', updates: [], state: 10, final: true, streamEpoch: 3 };
      },
      applyUpdate: async () => undefined,
      persistCursor: () => undefined,
      fullResync: async () => null,
      sleep: async () => undefined,
      jitterMs: () => 0,
    },
  });
  await assert.rejects(consumer.runCatchup('a', 1_000));
  const second = await consumer.runCatchup('b', 2_000);
  assert.equal(second, 'caught_up');
  void h;
});

// ---------------------------------------------------------------------------
// Beacon and the kill switch (plugin half of 9.1 finding 4)
// ---------------------------------------------------------------------------

test('a beacon ahead of the cursor schedules a catch-up', async () => {
  const h = harness({
    fetchScript: [
      { kind: 'ok', updates: [upd(11)], state: 11, final: true, streamEpoch: 3 },
    ],
  });
  await h.consumer.onBeacon({ seq: 11, streamEpoch: 3 }, 1_000);
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.consumer.cursor.seq, 11);
});

test('a beacon at the cursor is zero requests', async () => {
  const h = harness();
  await h.consumer.onBeacon({ seq: 10, streamEpoch: 3 }, 1_000);
  assert.equal(h.fetchCalls.length, 0);
});

test('a beacon with a new epoch forces the full resync', async () => {
  const h = harness();
  await h.consumer.onBeacon({ seq: 10, streamEpoch: 9 }, 1_000);
  assert.equal(h.resyncCount(), 1);
});

test('two missed beacons on a live socket mean a silent room drop: reconnect', () => {
  const last = 1_000_000;
  const now = last + 2 * BEACON_INTERVAL_MS + 5_000;
  assert.equal(beaconWatchdog(last, now, true, true), 'reconnect');
});

test('KILL SWITCH: no stream authority means legacy cadence, never a reconnect loop', () => {
  // SERVE off stops beacons. The watchdog must NOT keep tearing the
  // socket down; the daemon reverts to the legacy sweep instead (spec 8).
  const last = 1_000_000;
  const now = last + 10 * BEACON_INTERVAL_MS;
  assert.equal(beaconWatchdog(last, now, true, false), 'healthy');
  assert.equal(sweepMode(null), 'legacy');
  assert.equal(
    sweepMode({ enabled: false, epoch: 1, beaconSeenOnConnection: true }),
    'legacy',
  );
  assert.equal(
    sweepMode({ enabled: true, epoch: 1, beaconSeenOnConnection: false }),
    'legacy',
  );
  assert.equal(
    sweepMode({ enabled: true, epoch: 1, beaconSeenOnConnection: true }),
    'stream',
  );
});
