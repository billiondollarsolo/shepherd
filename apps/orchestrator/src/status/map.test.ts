import { describe, expect, it, vi } from 'vitest';
import type { Status, StatusUpdateMessage } from '@flock/shared';
import { StatusMap } from './map.js';

/**
 * US-14 — In-memory status map + WS fan-out.
 *
 * Acceptance (spec §9 US-14, NFR-PERF1):
 *  - Status transitions update the in-memory map and fan out over the `status`
 *    WS channel WITHOUT any synchronous DB read/write on the path.
 *  - A test FAILS if the DB is touched synchronously on a transition.
 *
 * These are pure unit tests (no real WS server, no DB) — the map takes injected
 * subscribers + an OPTIONAL write-behind sink so the hot path stays DB-free.
 */

const TS = '2026-05-29T05:00:00.000Z';

/** Deterministic clock so emitted `ts` values are assertable. */
function fixedClock(): () => string {
  return () => TS;
}

describe('StatusMap — in-memory authoritative status (US-14)', () => {
  it('starts empty: unknown sessions have no status', () => {
    const map = new StatusMap({ clock: fixedClock() });
    expect(map.get('s1')).toBeUndefined();
    expect(map.snapshot()).toEqual({});
  });

  it('records a transition into the in-memory map', () => {
    const map = new StatusMap({ clock: fixedClock() });
    map.set('s1', 'running');
    expect(map.get('s1')).toEqual({ status: 'running', detail: null, ts: TS, lastStatusTransitionAt: TS });
  });

  it('carries an optional detail string', () => {
    const map = new StatusMap({ clock: fixedClock() });
    map.set('s1', 'awaiting_input', 'permission_prompt');
    expect(map.get('s1')?.detail).toBe('permission_prompt');
  });

  it('set(persist=false) fans out the live dot but writes NO event (OSC heuristic)', () => {
    const writes: Array<[string, Status]> = [];
    const received: StatusUpdateMessage[] = [];
    const map = new StatusMap({
      clock: fixedClock(),
      writeBehind: (id, status) => writes.push([id, status]),
    });
    map.subscribe((m) => received.push(m));

    const applied = map.set('s1', 'idle', 'osc:output-quiet', false);

    expect(applied).toBe(true);
    expect(map.get('s1')?.status).toBe('idle'); // live state updated
    expect(received).toHaveLength(1); // fanned out to the live dot
    expect(writes).toEqual([]); // …but NO timeline event row
  });

  it('seed() restores status WITHOUT writing an event or fanning out (boot-restore)', () => {
    const writes: Array<[string, Status]> = [];
    const received: StatusUpdateMessage[] = [];
    const map = new StatusMap({
      clock: fixedClock(),
      writeBehind: (id, status) => writes.push([id, status]),
    });
    map.subscribe((m) => received.push(m));

    map.seed('s1', 'idle', 'osc:output-quiet');

    // In-memory state restored…
    expect(map.get('s1')).toEqual({ status: 'idle', detail: 'osc:output-quiet', ts: TS, lastStatusTransitionAt: TS });
    // …but NO write-behind event and NO fan-out (a restart adds no timeline row).
    expect(writes).toEqual([]);
    expect(received).toEqual([]);
  });

  it('snapshot returns a copy, not the live internal map', () => {
    const map = new StatusMap({ clock: fixedClock() });
    map.set('s1', 'running');
    const snap = map.snapshot();
    // Mutating the snapshot must not corrupt internal state.
    delete snap['s1'];
    expect(map.get('s1')).toBeDefined();
  });

  it('fans out a status WS message on every transition', () => {
    const received: StatusUpdateMessage[] = [];
    const map = new StatusMap({ clock: fixedClock() });
    map.subscribe((msg) => received.push(msg));

    map.set('s1', 'starting');
    map.set('s1', 'running');

    expect(received).toEqual<StatusUpdateMessage[]>([
      { channel: 'status', sessionId: 's1', status: 'starting', detail: null, ts: TS, lastStatusTransitionAt: TS },
      { channel: 'status', sessionId: 's1', status: 'running', detail: null, ts: TS, lastStatusTransitionAt: TS },
    ]);
  });

  it('fans out to ALL subscribers', () => {
    const a: Status[] = [];
    const b: Status[] = [];
    const map = new StatusMap({ clock: fixedClock() });
    map.subscribe((m) => a.push(m.status));
    map.subscribe((m) => b.push(m.status));

    map.set('s1', 'awaiting_input');

    expect(a).toEqual(['awaiting_input']);
    expect(b).toEqual(['awaiting_input']);
  });

  it('unsubscribe stops further fan-out to that subscriber', () => {
    const received: Status[] = [];
    const map = new StatusMap({ clock: fixedClock() });
    const off = map.subscribe((m) => received.push(m.status));

    map.set('s1', 'running');
    off();
    map.set('s1', 'idle');

    expect(received).toEqual(['running']);
  });

  it('one failing subscriber does not block the others or the map update', () => {
    const good: Status[] = [];
    const map = new StatusMap({ clock: fixedClock() });
    map.subscribe(() => {
      throw new Error('boom');
    });
    map.subscribe((m) => good.push(m.status));

    expect(() => map.set('s1', 'error')).not.toThrow();
    expect(good).toEqual(['error']);
    expect(map.get('s1')?.status).toBe('error');
  });

  it('rejects illegal transitions and does NOT fan out (terminal state)', () => {
    const received: Status[] = [];
    const map = new StatusMap({ clock: fixedClock() });
    map.subscribe((m) => received.push(m.status));

    map.set('s1', 'done'); // terminal
    const changed = map.set('s1', 'running'); // illegal: done -> running

    expect(changed).toBe(false);
    expect(map.get('s1')?.status).toBe('done');
    // Only the legal `done` transition fanned out.
    expect(received).toEqual(['done']);
  });

  it('allows reconciling out of a terminal state via disconnected', () => {
    const map = new StatusMap({ clock: fixedClock() });
    map.set('s1', 'done');
    expect(map.set('s1', 'disconnected')).toBe(true);
    expect(map.set('s1', 'running')).toBe(true); // reconcile back from disconnected
    expect(map.get('s1')?.status).toBe('running');
  });

  it('idempotent self-transition still fans out (re-assertion)', () => {
    const received: Status[] = [];
    const map = new StatusMap({ clock: fixedClock() });
    map.subscribe((m) => received.push(m.status));
    map.set('s1', 'running');
    expect(map.set('s1', 'running')).toBe(true);
    expect(received).toEqual(['running', 'running']);
  });

  it('delete drops a session from the map', () => {
    const map = new StatusMap({ clock: fixedClock() });
    map.set('s1', 'running');
    map.delete('s1');
    expect(map.get('s1')).toBeUndefined();
  });

  // ---- NFR-PERF1: NO synchronous DB on the live path ----------------------

  it('does NOT call the write-behind sink synchronously during set()', () => {
    // The sink stand-in throws if invoked synchronously within the set() call
    // frame. We detect "synchronous" by flipping a flag around the call.
    let insideSet = false;
    const sink = vi.fn(() => {
      if (insideSet) {
        throw new Error('DB sink was touched SYNCHRONOUSLY on the status path');
      }
      return Promise.resolve();
    });

    const map = new StatusMap({ clock: fixedClock(), writeBehind: sink });

    insideSet = true;
    map.set('s1', 'running');
    insideSet = false;

    // It MAY be scheduled, but never invoked synchronously.
    expect(sink).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('schedules the write-behind sink AFTER fan-out (eventually, async)', async () => {
    const order: string[] = [];
    const sink = vi.fn(() => {
      order.push('db');
      return Promise.resolve();
    });
    const map = new StatusMap({ clock: fixedClock(), writeBehind: sink });
    map.subscribe(() => order.push('fanout'));

    map.set('s1', 'running');
    // Synchronously, only the fan-out has happened.
    expect(order).toEqual(['fanout']);

    // Let the microtask/macrotask queue drain.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['fanout', 'db']);
    expect(sink).toHaveBeenCalledWith('s1', 'running', null);
  });

  it('a hung write-behind sink does NOT delay fan-out (NFR-PERF1)', () => {
    // A sink that never resolves must not block set()/fan-out at all.
    const sink = vi.fn(() => new Promise<void>(() => {}));
    const received: Status[] = [];
    const map = new StatusMap({ clock: fixedClock(), writeBehind: sink });
    map.subscribe((m) => received.push(m.status));

    const start = Date.now();
    map.set('s1', 'running');
    const elapsed = Date.now() - start;

    expect(received).toEqual(['running']);
    expect(elapsed).toBeLessThan(50); // returned immediately, did not await
  });

  it('a rejecting write-behind sink does not crash the live path', async () => {
    const sink = vi.fn(() => Promise.reject(new Error('db down')));
    const map = new StatusMap({ clock: fixedClock(), writeBehind: sink });
    const received: Status[] = [];
    map.subscribe((m) => received.push(m.status));

    expect(() => map.set('s1', 'error')).not.toThrow();
    expect(received).toEqual(['error']);
    // Drain so the unhandled rejection (if any) would surface in the test run.
    await new Promise((r) => setTimeout(r, 0));
    expect(map.get('s1')?.status).toBe('error');
  });

  it('works with NO write-behind sink at all (sink is optional)', () => {
    const map = new StatusMap({ clock: fixedClock() });
    expect(() => map.set('s1', 'running')).not.toThrow();
    expect(map.get('s1')?.status).toBe('running');
  });
});
