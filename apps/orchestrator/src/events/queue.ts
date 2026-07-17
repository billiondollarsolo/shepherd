/**
 * US-21 — Async write-behind event log (spec §4.1, §6, §15; NFR-PERF1).
 *
 * Every status transition (from the in-memory status map, US-14) and every raw
 * agent hook callback (from the hook endpoint, US-15) must produce an `events`
 * row — but Postgres is NEVER on the live status path (spec §6.6). This queue is
 * the seam that makes that true: callers `enqueue()` an {@link EventRecord}
 * SYNCHRONOUSLY (it only appends to an in-memory buffer and returns), and a
 * background drain loop writes the buffered rows to Postgres off the hot path.
 *
 * The hard guarantees (proved in `queue.test.ts`):
 *   - `enqueue()` never awaits the DB writer — a wedged/slow/blocked DB cannot
 *     delay the fan-out path it is wired into (NFR-PERF1, the headline
 *     "artificially slow writer" test);
 *   - a throwing/rejecting writer is contained (retried, then reported via
 *     `onError`), never propagated to the live path;
 *   - the buffer is bounded — a permanently-down DB sheds the oldest events
 *     rather than growing without limit (spec §10 "event-log writes buffer/retry").
 *
 * The actual SQL insert is injected as an {@link EventWriter} so this module is a
 * pure-logic unit (no DB import); the Drizzle-backed writer lives in
 * `drizzle-event-writer.ts`.
 */
import type { EventSource, Status } from '@flock/shared';

/**
 * One row destined for the append-only `events` table (spec §6). Column-aligned
 * with the Drizzle `events` schema:
 *   - `mappedStatus` → `mapped_status`
 *   - `agentEventRaw` → `agent_event_raw`
 */
export interface EventRecord {
  readonly sessionId: string;
  /** hook | osc | pty | orchestrator (spec §6 events.source). */
  readonly source: EventSource;
  /** Free-form event kind (e.g. `status_transition`, the agent hook name). */
  readonly type: string;
  /** The status this event mapped to, or null when it yielded no transition. */
  readonly mappedStatus: Status | null;
  /** Raw agent payload exactly as received; null for orchestrator-internal events. */
  readonly agentEventRaw: unknown;
  /** Optional human-facing detail. */
  readonly detail: string | null;
}

/**
 * Persists a single events row. Async; may reject on a transient/permanent DB
 * failure. Injected so the queue stays a pure unit and the Drizzle insert is
 * tested separately (`drizzle-event-writer.ts`).
 */
export type EventWriter = (record: EventRecord) => Promise<void>;

/** A record dropped because the bounded buffer overflowed (DB wedged too long). */
export type DropHandler = (record: EventRecord) => void;

/** A write that exhausted its retries. The live path is unaffected either way. */
export type ErrorHandler = (record: EventRecord, error: unknown) => void;

export interface WriteBehindEventQueueOptions {
  /** The sink that actually writes a row (Drizzle insert in production). */
  writer: EventWriter;
  /**
   * Max buffered (not-yet-written) events. When exceeded, the OLDEST buffered
   * event is dropped so the queue can never grow without bound while the DB is
   * down (spec §10). Default: 10_000.
   */
  maxQueue?: number;
  /**
   * How many times to retry a failed write before giving up on that row and
   * reporting via `onError`. Default: 5.
   */
  maxRetries?: number;
  /**
   * Base backoff (ms) between retries; grows linearly per attempt. Injectable so
   * tests run without real delays. Default: 0 (retry immediately) — production
   * wiring sets a real value.
   */
  retryBackoffMs?: number;
  /** Deferred backoff scheduler; injectable for tests. Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Reported when a write exhausts its retries (logging/metrics). */
  onError?: ErrorHandler;
  /** Reported when an event is shed due to buffer overflow. */
  onDrop?: DropHandler;
  /**
   * Schedules the background drain loop OFF the live path so `enqueue()` returns
   * before any writer code runs. Defaults to `queueMicrotask`; injectable for
   * tests. (Mirrors the StatusMap's `defer` seam.)
   */
  defer?: (fn: () => void) => void;
}

const DEFAULT_MAX_QUEUE = 10_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_BACKOFF_MS = 0;

const defaultSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));

const defaultDefer = (fn: () => void): void => {
  queueMicrotask(fn);
};

/**
 * A minimal HookEventRecord-compatible shape (the hook endpoint's seam, US-15).
 * Declared structurally here so this module need not depend on `hooks/`.
 */
interface HookEventLike {
  readonly sessionId: string;
  readonly source: 'hook';
  readonly mappedStatus: Status | null;
  readonly agentEventRaw: unknown;
  readonly detail: string | null;
  /** Optional explicit type; defaults to a hook-derived value. */
  readonly type?: string;
}

export class WriteBehindEventQueue {
  private readonly writer: EventWriter;
  private readonly maxQueue: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onError?: ErrorHandler;
  private readonly onDrop?: DropHandler;
  private readonly defer: (fn: () => void) => void;

  /** In-memory FIFO buffer of not-yet-written rows (the write-behind buffer). */
  private readonly buffer: EventRecord[] = [];
  /** The currently-running drain loop, if any. */
  private draining: Promise<void> | null = null;
  /** Resolvers waiting on the buffer to fully drain (for `flush()`). */
  private readonly drainWaiters: Array<() => void> = [];
  private stopped = false;

  constructor(opts: WriteBehindEventQueueOptions) {
    this.writer = opts.writer;
    this.maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.sleep = opts.sleep ?? defaultSleep;
    this.onError = opts.onError;
    this.onDrop = opts.onDrop;
    this.defer = opts.defer ?? defaultDefer;
  }

  /** Number of buffered events not yet written (diagnostics/tests). */
  get pending(): number {
    return this.buffer.length;
  }

  /**
   * Buffer an event for the write-behind log. SYNCHRONOUS and non-blocking: it
   * appends to the in-memory buffer, kicks the background drain loop, and
   * returns immediately. It NEVER awaits the DB writer (NFR-PERF1) and NEVER
   * throws — a full buffer sheds the oldest event instead.
   */
  enqueue(record: EventRecord): void {
    if (this.stopped) return;

    // Bound the buffer: under a wedged DB, drop the OLDEST to stay in memory
    // budget (spec §10 — no unbounded queue).
    while (this.buffer.length >= this.maxQueue) {
      const dropped = this.buffer.shift();
      if (dropped && this.onDrop) {
        try {
          this.onDrop(dropped);
        } catch {
          /* a bad drop handler must not break enqueue */
        }
      }
    }

    this.buffer.push(record);
    // Kick the drain loop WITHOUT awaiting it — this is what keeps the live path
    // free of any DB latency.
    this.kick();
  }

  /**
   * A {@link WriteBehindSink}-shaped adapter for the in-memory status map
   * (US-14): `(sessionId, status, detail) => void`. Wiring this as the map's
   * `writeBehind` makes every transition enqueue an `events` row off the live
   * path (US-21 acceptance: "every transition enqueues an events row").
   */
  transitionSink(): (sessionId: string, status: Status, detail: string | null) => void {
    return (sessionId, status, detail) => {
      this.enqueue({
        sessionId,
        source: 'orchestrator',
        type: 'status_transition',
        mappedStatus: status,
        agentEventRaw: null,
        detail,
      });
    };
  }

  /**
   * A {@link HookEventEnqueue}-shaped adapter for the hook endpoint (US-15):
   * `(HookEventRecord) => void`. Wiring this as the endpoint's `enqueueEvent`
   * appends the raw hook payload to the async log without touching the hot path.
   */
  hookEnqueue(): (e: HookEventLike) => void {
    return (e) => {
      this.enqueue({
        sessionId: e.sessionId,
        source: e.source,
        type: e.type ?? this.deriveHookType(e.agentEventRaw),
        mappedStatus: e.mappedStatus,
        agentEventRaw: e.agentEventRaw,
        detail: e.detail,
      });
    };
  }

  /**
   * Resolves once the buffer is empty (all currently-queued events written).
   * For tests and graceful shutdown — NOT for the live path.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0 && this.draining === null) return;
    this.kick();
    await new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  /**
   * Stop accepting new events and drain what remains, then halt the loop. Safe
   * to await for a graceful shutdown.
   */
  async stop(): Promise<void> {
    if (this.stopped) {
      await this.draining;
      return;
    }
    // Drain the remaining buffer first, THEN mark stopped so the in-flight loop
    // finishes its work.
    await this.flush();
    this.stopped = true;
    await this.draining;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Start the drain loop if it is not already running. Never awaited by callers.
   *
   * The actual draining is scheduled on a MICROTASK (`queueMicrotask`), not run
   * inline: this guarantees `enqueue()`'s synchronous frame returns BEFORE any
   * writer code executes, so the live path never even begins the DB work, let
   * alone awaits it (NFR-PERF1). `this.draining` is set synchronously so a burst
   * of enqueues collapses to a single drain loop.
   */
  private kick(): void {
    if (this.draining) return;
    let resolveStarted!: () => void;
    // A placeholder promise marks the loop as "starting" synchronously so
    // concurrent kicks coalesce; it is replaced by the real loop on the microtask.
    this.draining = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    this.defer(() => {
      void this.drainLoop()
        .catch(() => {
          /* drainLoop never throws, but contain anything defensively */
        })
        .finally(() => {
          this.draining = null;
          resolveStarted();
          // If new events arrived during the final tick, keep draining;
          // otherwise wake any flush() waiters.
          if (this.buffer.length > 0 && !this.stopped) {
            this.kick();
          } else {
            this.resolveDrainWaiters();
          }
        });
    });
  }

  private resolveDrainWaiters(): void {
    if (this.buffer.length > 0) return;
    const waiters = this.drainWaiters.splice(0);
    for (const w of waiters) w();
  }

  /** Drains the buffer FIFO, one row at a time, with bounded retries. */
  private async drainLoop(): Promise<void> {
    while (this.buffer.length > 0) {
      const record = this.buffer[0]!;
      // writeWithRetry handles its own retries + onError on give-up.
      await this.writeWithRetry(record);
      // Whether it succeeded or was given up on, advance past it so a single
      // poison row cannot wedge the whole log.
      if (this.buffer[0] === record) this.buffer.shift();
      // Wake flush() waiters as soon as the buffer empties.
      if (this.buffer.length === 0) this.resolveDrainWaiters();
    }
  }

  /** Attempts one write up to `maxRetries` times; returns success. Never throws. */
  private async writeWithRetry(record: EventRecord): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.writer(record);
        return true;
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryBackoffMs * (attempt + 1));
        }
      }
    }
    if (this.onError) {
      try {
        this.onError(record, lastError);
      } catch {
        /* a bad error handler must not break the drain loop */
      }
    }
    return false;
  }

  /** Best-effort `type` for a hook row when the caller did not supply one. */
  private deriveHookType(raw: unknown): string {
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      for (const key of ['hook_event_name', 'hook', 'type', 'event', 'name', 'kind']) {
        const v = obj[key];
        if (typeof v === 'string' && v.length > 0) return v;
      }
    }
    return 'hook';
  }
}
