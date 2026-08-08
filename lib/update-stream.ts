/**
 * Agent Update Stream consumer, the daemon half
 * (docs/architecture/agent-message-routing.md sections 5.2, 5.4, 5.7, 8;
 * that doc lives in the BGOS repo).
 *
 * Pure state machine with injected IO, in the poll-core tradition: every
 * decision here is testable without a socket or a backend. server.ts owns
 * the wiring (which events carry seq, how a card is handed to the agent,
 * what a full resync means: the WHOLE boot sequence, not a message sweep).
 *
 * The trust rule is arithmetic, not faith in the transport:
 *   seq == local + 1  apply and advance
 *   seq <= local      duplicate, drop
 *   seq >  local + 1  possible gap: buffer 500ms (commit reorder produces
 *                     exactly this transient), then ONE getDifference call
 * An epoch change anywhere means the stream was paused and re-enabled
 * while we held a cursor: the cursor spans an unlogged window and is
 * untrustworthy, so we run one full resync and adopt the server's state.
 *
 * KILL SWITCH (the 9.1 finding): stream authority is per connection.
 * Losing it, or losing beacons, DEGRADES to the legacy sweep cadence. It
 * must never become a reconnect loop.
 */

export const GAP_BUFFER_MS = 500;
export const BEACON_INTERVAL_MS = 60_000;
export const CATCHUP_FETCH_LIMIT = 100;

export interface StreamCursor {
  seq: number;
  epoch: number;
}

export interface StreamUpdate {
  seq: number;
  kind: string;
  chatId: number | null;
  messageId: number | null;
  payload: Record<string, unknown>;
}

export type FetchResult =
  | {
      kind: 'ok';
      updates: StreamUpdate[];
      state: number;
      final: boolean;
      streamEpoch: number;
    }
  | { kind: 'too_old'; state: number; streamEpoch: number }
  | { kind: 'invalid_cursor'; state: number; streamEpoch: number }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'not_found' };

export interface ConsumerDeps {
  /** GET /integrations/updates?since=... for this assistant. */
  fetchUpdates(since: number): Promise<FetchResult>;
  /**
   * Hand one replayed update to the daemon. MUST resolve only after the
   * handoff genuinely succeeded (5.7: handoff before advance); a
   * rejection pins the cursor so the next chain redelivers, and message
   * id dedup absorbs the overlap.
   */
  applyUpdate(update: StreamUpdate): Promise<void>;
  /** Persist the stream cursor (called after every advance). */
  persistCursor(cursor: StreamCursor): void | Promise<void>;
  /**
   * The WHOLE boot sequence (5.7): chat discovery, meetings and
   * meeting_state_resync, config reconcile. Returns the server state to
   * adopt, or null when resync could not complete (cursor left as is;
   * the next beacon or gap tries again).
   */
  fullResync(): Promise<{ state: number; epoch: number } | null>;
  sleep(ms: number): Promise<void>;
  /** Jitter before beacon-triggered fetches, 0..5000ms in production. */
  jitterMs(): number;
}

export type StampedDecision =
  | 'applied'
  | 'duplicate'
  | 'buffered'
  | 'in_difference'
  | 'epoch_resync';

export type CatchupOutcome =
  | 'caught_up'
  | 'resynced'
  | 'feature_absent';

export function decideStamped(
  localSeq: number,
  localEpoch: number,
  seq: number,
  streamEpoch: number,
):
  | { action: 'apply' }
  | { action: 'duplicate' }
  | { action: 'gap' }
  | { action: 'epoch_resync' } {
  if (streamEpoch !== localEpoch) return { action: 'epoch_resync' };
  if (seq === localSeq + 1) return { action: 'apply' };
  if (seq <= localSeq) return { action: 'duplicate' };
  return { action: 'gap' };
}

/**
 * Two missed beacons on a socket that still reports connected is the
 * beacon's UNIQUE job: evidence of a silent server-side room drop, so
 * tear down and reconnect. But ONLY while the stream is active; with
 * authority absent (SERVE off, old backend) beacons are simply not a
 * thing and the daemon must stay put on its legacy cadence.
 */
export function beaconWatchdog(
  lastBeaconAtMs: number,
  nowMs: number,
  socketConnected: boolean,
  streamActive: boolean,
): 'healthy' | 'reconnect' {
  if (!streamActive || !socketConnected) return 'healthy';
  return nowMs - lastBeaconAtMs > 2 * BEACON_INTERVAL_MS
    ? 'reconnect'
    : 'healthy';
}

export interface StreamAuthority {
  enabled: boolean;
  epoch: number;
  beaconSeenOnConnection: boolean;
}

/**
 * Sweep demotion is gated on BOTH authority and a beacon on the CURRENT
 * connection (spec 8): flag off, old backend, or a beaconless connection
 * all mean the legacy 5 minute sweep keeps running unchanged.
 */
export function sweepMode(
  authority: StreamAuthority | null,
): 'legacy' | 'stream' {
  if (!authority) return 'legacy';
  return authority.enabled && authority.beaconSeenOnConnection
    ? 'stream'
    : 'legacy';
}

interface BufferedEvent {
  seq: number;
  streamEpoch: number;
  apply: () => Promise<void>;
  deadlineMs: number;
}

export class UpdateStreamConsumer {
  cursor: StreamCursor;
  private readonly deps: ConsumerDeps;
  private readonly buffer = new Map<number, BufferedEvent>();
  private chainPromise: Promise<CatchupOutcome> | null = null;
  private redo = false;
  private pushArrivedDuringChain = false;

  constructor(options: { initialCursor: StreamCursor; deps: ConsumerDeps }) {
    this.cursor = { ...options.initialCursor };
    this.deps = options.deps;
  }

  get inDifference(): boolean {
    return this.chainPromise != null;
  }

  /**
   * A live stamped event. `apply` is the daemon's own handler for this
   * event (forward the card, bump the chat cursor); it runs only when
   * the arithmetic says apply, and its failure pins the stream cursor.
   */
  async onStampedEvent(
    stamp: { seq: number; streamEpoch: number },
    apply: () => Promise<void>,
    nowMs: number,
  ): Promise<StampedDecision> {
    if (this.chainPromise) {
      // Included in the difference read; ignore, but remember to run one
      // more round after the chain so the residual race window closes
      // (5.4).
      this.pushArrivedDuringChain = true;
      return 'in_difference';
    }
    const decision = decideStamped(
      this.cursor.seq,
      this.cursor.epoch,
      stamp.seq,
      stamp.streamEpoch,
    );
    if (decision.action === 'duplicate') return 'duplicate';
    if (decision.action === 'epoch_resync') {
      await this.resync();
      return 'epoch_resync';
    }
    if (decision.action === 'gap') {
      this.buffer.set(stamp.seq, {
        seq: stamp.seq,
        streamEpoch: stamp.streamEpoch,
        apply,
        deadlineMs: nowMs + GAP_BUFFER_MS,
      });
      return 'buffered';
    }
    // Handoff BEFORE advance (5.7): a failed apply leaves the cursor
    // where it was, so the next chain redelivers this seq.
    await apply();
    this.cursor.seq = stamp.seq;
    await this.deps.persistCursor({ ...this.cursor });
    await this.drainBuffer();
    return 'applied';
  }

  /** Retry buffered successors; called after every applied event. */
  private async drainBuffer(): Promise<void> {
    for (;;) {
      const next = this.buffer.get(this.cursor.seq + 1);
      if (!next) return;
      this.buffer.delete(next.seq);
      await next.apply();
      this.cursor.seq = next.seq;
      await this.deps.persistCursor({ ...this.cursor });
    }
  }

  /**
   * The grammers deadline check: a buffered event older than 500ms is a
   * real gap. The buffer is discarded (the difference includes those
   * updates) and one chain runs.
   */
  async checkDeadlines(nowMs: number): Promise<void> {
    let expired = false;
    for (const event of this.buffer.values()) {
      if (event.deadlineMs <= nowMs) {
        expired = true;
        break;
      }
    }
    if (!expired) return;
    this.buffer.clear();
    await this.runCatchup('gap_deadline', nowMs);
  }

  async onBeacon(
    beacon: { seq: number; streamEpoch: number },
    nowMs: number,
  ): Promise<void> {
    if (this.chainPromise) {
      this.pushArrivedDuringChain = true;
      return;
    }
    if (beacon.streamEpoch !== this.cursor.epoch) {
      await this.resync();
      return;
    }
    if (beacon.seq <= this.cursor.seq) return;
    const jitter = this.deps.jitterMs();
    if (jitter > 0) await this.deps.sleep(jitter);
    await this.runCatchup('beacon', nowMs);
  }

  /**
   * The getDifference chain (5.4): single flight, redo flag instead of a
   * second chain, intermediate cursor persisted before every next slice,
   * 429 waits and resumes from the intermediate cursor, tooOld and
   * invalidCursor and epoch changes route to ONE full resync, 404 means
   * old backend.
   */
  async runCatchup(reason: string, nowMs: number): Promise<CatchupOutcome> {
    if (this.chainPromise) {
      this.redo = true;
      return this.chainPromise;
    }
    this.chainPromise = this.chain();
    try {
      return await this.chainPromise;
    } finally {
      this.chainPromise = null;
    }
  }

  private async chain(): Promise<CatchupOutcome> {
    let rounds = 0;
    do {
      this.redo = false;
      this.pushArrivedDuringChain = false;
      rounds += 1;
      for (;;) {
        const result = await this.deps.fetchUpdates(this.cursor.seq);
        if (result.kind === 'not_found') return 'feature_absent';
        if (result.kind === 'rate_limited') {
          await this.deps.sleep(result.retryAfterSeconds * 1000);
          continue;
        }
        if (result.kind === 'too_old' || result.kind === 'invalid_cursor') {
          await this.resync();
          return 'resynced';
        }
        if (result.streamEpoch !== this.cursor.epoch) {
          await this.resync();
          return 'resynced';
        }
        for (const update of result.updates) {
          // Inside difference results the gap arithmetic is off: apply
          // idempotently in order and adopt the returned state (5.5).
          await this.deps.applyUpdate(update);
        }
        this.cursor.seq = result.state;
        await this.deps.persistCursor({ ...this.cursor });
        if (result.final) break;
      }
      // Redo when someone asked for another chain mid-flight, or when a
      // live push arrived while we were ignoring pushes.
    } while ((this.redo || this.pushArrivedDuringChain) && rounds < 10);
    return 'caught_up';
  }

  private async resync(): Promise<void> {
    const adopted = await this.deps.fullResync();
    if (adopted) {
      this.cursor = { seq: adopted.state, epoch: adopted.epoch };
      await this.deps.persistCursor({ ...this.cursor });
    }
  }
}
