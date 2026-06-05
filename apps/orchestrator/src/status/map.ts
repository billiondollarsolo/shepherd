import {
  canTransition,
  type AgentTelemetry,
  type Status,
  type StatusUpdateMessage,
} from '@flock/shared';

/**
 * US-14 — the in-memory authoritative status map (spec §6.6, §7; NFR-PERF1).
 *
 * This is the single source of truth for the LIVE status of every session. Every
 * transition mutates the in-memory map and fans out a `status` WS message
 * synchronously to all subscribers, then OPTIONALLY schedules a write-behind
 * mirror to Postgres on a later tick.
 *
 * The hard rule (NFR-PERF1, spec §6.6): **no synchronous DB read or write ever
 * happens on the transition path.** Postgres is never on the live status path;
 * the `events` append-log + the `agent_sessions.status` mirror are written
 * asynchronously, off the hot path, and a slow/blocked/failing DB must never
 * delay or break fan-out. See `map.test.ts` for the tests that fail if this is
 * violated.
 */

/** A session's live status entry held in the map. */
export interface StatusEntry {
  readonly status: Status;
  readonly detail: string | null;
  /** ISO-8601 timestamp of the transition. */
  readonly ts: string;
}

/** A fan-out subscriber. Invoked synchronously on every transition. */
export type StatusSubscriber = (msg: StatusUpdateMessage) => void;

/** Unsubscribe handle returned by {@link StatusMap.subscribe}. */
export type Unsubscribe = () => void;

/**
 * The write-behind mirror sink (NFR-PERF1). Invoked OFF the live path (next
 * tick) with the post-transition state so Postgres can be updated lazily. It is
 * deliberately fire-and-forget: its returned promise is never awaited on the
 * transition path, and a rejection is swallowed (logged by the caller's wiring)
 * so a down DB cannot break live status.
 *
 * Wired in production to enqueue both the async `events` row (US-21) and the
 * `agent_sessions.status` mirror update; left undefined in pure unit tests.
 */
export type WriteBehindSink = (
  sessionId: string,
  status: Status,
  detail: string | null,
) => Promise<void> | void;

export interface StatusMapOptions {
  /** Injectable clock for deterministic timestamps in tests. */
  clock?: () => string;
  /** Optional async write-behind mirror (never on the live path). */
  writeBehind?: WriteBehindSink;
  /**
   * Schedules the write-behind work off the live path. Defaults to
   * `queueMicrotask`-then-`setTimeout`-style deferral via `queueMicrotask`,
   * which guarantees the sink never runs inside `set()`'s synchronous frame.
   * Injectable for tests.
   */
  defer?: (fn: () => void) => void;
}

const defaultDefer = (fn: () => void): void => {
  // queueMicrotask runs AFTER the current synchronous frame completes, so the
  // sink can never be observed running inside set(). It is also cheaper than a
  // macrotask timer for the common case.
  queueMicrotask(fn);
};

/**
 * The in-memory status map. Authoritative for live status; DB is a write-behind
 * mirror only.
 */
export class StatusMap {
  private readonly map = new Map<string, StatusEntry>();
  private readonly subscribers = new Set<StatusSubscriber>();
  private readonly clock: () => string;
  private readonly writeBehind?: WriteBehindSink;
  private readonly defer: (fn: () => void) => void;

  constructor(opts: StatusMapOptions = {}) {
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.writeBehind = opts.writeBehind;
    this.defer = opts.defer ?? defaultDefer;
  }

  /** Current live status of a session, or undefined if unknown. */
  get(sessionId: string): StatusEntry | undefined {
    return this.map.get(sessionId);
  }

  /** A defensive copy of the whole live map (e.g. to seed a fresh subscriber). */
  snapshot(): Record<string, StatusEntry> {
    const out: Record<string, StatusEntry> = {};
    for (const [id, entry] of this.map) out[id] = entry;
    return out;
  }

  /**
   * Apply a transition.
   *
   * Returns `true` if the transition was applied (and fanned out), `false` if it
   * was rejected as illegal (e.g. `done -> running`) — in which case the map is
   * unchanged and nothing is fanned out.
   *
   * On the live path this performs, in order, with ZERO DB access:
   *   1. legality check (pure, in-memory),
   *   2. in-memory map mutation,
   *   3. synchronous fan-out to all subscribers,
   *   4. scheduling (NOT awaiting) the write-behind mirror on a later tick.
   */
  set(
    sessionId: string,
    status: Status,
    detail: string | null = null,
    persist = true,
    meta?: AgentTelemetry,
  ): boolean {
    const current = this.map.get(sessionId);
    if (current && !canTransition(current.status, status)) {
      return false;
    }

    const ts = this.clock();
    const entry: StatusEntry = { status, detail, ts };
    this.map.set(sessionId, entry);

    // `meta` (live telemetry) rides the fan-out ONLY — it is NOT stored in the map
    // and NEVER persisted (it's derived, high-churn, and recomputed each frame).
    const msg: StatusUpdateMessage = {
      channel: 'status',
      sessionId,
      status,
      detail,
      ts,
      ...(meta ? { meta } : {}),
    };
    this.fanOut(msg);

    // Write-behind: scheduled off the live path, fire-and-forget. A slow,
    // blocked, or rejecting sink must never affect the result of set().
    // `persist: false` (e.g. the OSC heuristic fallback) updates the live dot via
    // fan-out above but records NO event row — keeping debug-y, flappy transitions
    // out of the user-facing timeline.
    if (this.writeBehind && persist) {
      const sink = this.writeBehind;
      this.defer(() => {
        try {
          void Promise.resolve(sink(sessionId, status, detail)).catch(() => {
            // Swallowed: the DB is a mirror; a failed mirror write never breaks
            // live status. Production wiring is responsible for retry/logging.
          });
        } catch {
          // A synchronous throw from the sink is likewise contained.
        }
      });
    }

    return true;
  }

  /**
   * Restore a session's status WITHOUT recording an event or fanning out — used
   * on boot to re-establish the last-known live status. Unlike {@link set}, this
   * writes nothing to the event log, so a restart never adds a redundant
   * transition row (clients that connect afterward get it via the snapshot
   * replay). No legality check: it seeds, it doesn't transition.
   */
  seed(sessionId: string, status: Status, detail: string | null = null): void {
    this.map.set(sessionId, { status, detail, ts: this.clock() });
  }

  /** Remove a session from the live map (e.g. on terminate/teardown). */
  delete(sessionId: string): void {
    this.map.delete(sessionId);
  }

  /**
   * Subscribe to every future transition. The callback is invoked synchronously
   * within {@link set}. Returns an unsubscribe handle.
   */
  subscribe(fn: StatusSubscriber): Unsubscribe {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  private fanOut(msg: StatusUpdateMessage): void {
    for (const sub of this.subscribers) {
      try {
        sub(msg);
      } catch {
        // One bad subscriber must not block the map update or other subscribers.
      }
    }
  }
}
