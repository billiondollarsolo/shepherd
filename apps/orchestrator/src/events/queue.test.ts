import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WriteBehindEventQueue,
  type EventRecord,
  type EventWriter,
} from './queue.js';

/**
 * US-21 — Async write-behind event log (spec §6, §15; NFR-PERF1).
 *
 * The contract these tests pin down:
 *   1. `enqueue()` is SYNCHRONOUS and returns immediately — it only appends to an
 *      in-memory buffer; it NEVER awaits (or even begins) the DB writer within
 *      its own synchronous frame.
 *   2. A slow / blocked / failing writer can NEVER delay or break the live path:
 *      enqueue() returns in microseconds even when the writer hangs for seconds
 *      (the headline NFR-PERF1 proof — "artificially slow writer").
 *   3. Every transition produces exactly one events row; rows are written in
 *      FIFO order off the live path.
 *   4. A throwing/rejecting writer is contained (retried/dropped per policy),
 *      never propagated to the caller.
 *   5. The queue exposes adapters whose shapes exactly match the `WriteBehindSink`
 *      (status map, US-14) and `HookEventEnqueue` (hook endpoint, US-15) seams,
 *      so wiring them up cannot put Postgres on the live path.
 *
 * Hermetic teardown: any test that wedges a writer registers a `cleanup` that
 * releases it and awaits `stop()`, so no drain loop or pending microtask leaks
 * into the next test.
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    const c = cleanups.pop()!;
    await c();
  }
});

function makeRecord(over: Partial<EventRecord> = {}): EventRecord {
  return {
    sessionId: 's1',
    source: 'orchestrator',
    type: 'status_transition',
    mappedStatus: 'running',
    agentEventRaw: null,
    detail: null,
    ...over,
  };
}

/** A writer that blocks until `release()` is called. */
function blockingWriter(): { writer: EventWriter; release: () => void } {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writer: EventWriter = async () => {
    await blocked;
  };
  return { writer, release };
}

describe('WriteBehindEventQueue', () => {
  it('enqueue() returns synchronously and does NOT begin the writer in-frame', () => {
    const written: EventRecord[] = [];
    const writer: EventWriter = async (e) => {
      written.push(e);
    };
    const q = new WriteBehindEventQueue({ writer });
    cleanups.push(() => q.stop());

    q.enqueue(makeRecord());

    // The writer has not run yet — enqueue only buffered in memory (the drain
    // loop is scheduled on a microtask, off the synchronous frame).
    expect(written).toHaveLength(0);
    expect(q.pending).toBe(1);
  });

  it('drains queued events to the writer off the live path, in FIFO order', async () => {
    const written: EventRecord[] = [];
    const writer: EventWriter = async (e) => {
      written.push(e);
    };
    const q = new WriteBehindEventQueue({ writer });

    q.enqueue(makeRecord({ type: 'a' }));
    q.enqueue(makeRecord({ type: 'b' }));
    q.enqueue(makeRecord({ type: 'c' }));

    await q.flush();

    expect(written.map((e) => e.type)).toEqual(['a', 'b', 'c']);
    expect(q.pending).toBe(0);
    await q.stop();
  });

  it('an ARTIFICIALLY SLOW writer does not delay enqueue (NFR-PERF1)', async () => {
    const { writer, release } = blockingWriter();
    const q = new WriteBehindEventQueue({ writer });
    cleanups.push(async () => {
      release();
      await q.stop();
    });

    const start = performance.now();
    // Enqueue many transitions while the writer is wedged on the first one.
    for (let i = 0; i < 1000; i++) q.enqueue(makeRecord({ type: `t${i}` }));
    const elapsed = performance.now() - start;

    // 1000 enqueues complete near-instantly despite the wedged writer.
    expect(elapsed).toBeLessThan(50);
    expect(q.pending).toBe(1000);

    // Now let the writer proceed and confirm everything drains.
    release();
    await q.flush();
    expect(q.pending).toBe(0);
  });

  it('a slow writer never blocks the fan-out path it is wired into', async () => {
    const { writer, release } = blockingWriter();
    const q = new WriteBehindEventQueue({ writer });
    cleanups.push(async () => {
      release();
      await q.stop();
    });

    const fanOut: string[] = [];
    const onTransition = (sessionId: string, status: string): void => {
      fanOut.push(`${sessionId}:${status}`); // synchronous live work
      q.enqueue(makeRecord({ sessionId, mappedStatus: status as never }));
    };

    const start = performance.now();
    onTransition('s1', 'awaiting_input');
    const elapsed = performance.now() - start;

    // The live transition completed without waiting for the wedged DB.
    expect(fanOut).toEqual(['s1:awaiting_input']);
    expect(elapsed).toBeLessThan(20);

    release();
    await q.flush();
  });

  it('contains a rejecting writer: enqueue never throws and the queue keeps draining', async () => {
    const written: EventRecord[] = [];
    let calls = 0;
    const writer: EventWriter = async (e) => {
      calls++;
      if (e.type === 'boom') throw new Error('db down');
      written.push(e);
    };
    const onError = vi.fn();
    const q = new WriteBehindEventQueue({ writer, onError, maxRetries: 0 });

    expect(() => {
      q.enqueue(makeRecord({ type: 'ok1' }));
      q.enqueue(makeRecord({ type: 'boom' }));
      q.enqueue(makeRecord({ type: 'ok2' }));
    }).not.toThrow();

    await q.flush();

    // The good rows still landed; the bad one was reported, not propagated.
    expect(written.map((e) => e.type)).toEqual(['ok1', 'ok2']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(calls).toBe(3);
    await q.stop();
  });

  it('retries a transient failure before giving up', async () => {
    let attempts = 0;
    const writer: EventWriter = async () => {
      attempts++;
      if (attempts < 3) throw new Error('transient');
    };
    const onError = vi.fn();
    const q = new WriteBehindEventQueue({ writer, maxRetries: 3, onError });

    q.enqueue(makeRecord());
    await q.flush();

    expect(attempts).toBe(3); // failed twice, succeeded on the third
    expect(onError).not.toHaveBeenCalled();
    expect(q.pending).toBe(0);
    await q.stop();
  });

  it('drops the oldest event past a bounded capacity (no unbounded queue)', async () => {
    const { writer, release } = blockingWriter();
    const onDrop = vi.fn();
    const q = new WriteBehindEventQueue({ writer, maxQueue: 2, onDrop });
    cleanups.push(async () => {
      release();
      await q.stop();
    });

    q.enqueue(makeRecord({ type: '1' }));
    q.enqueue(makeRecord({ type: '2' }));
    q.enqueue(makeRecord({ type: '3' })); // overflows: oldest still-buffered dropped

    // Asserted SYNCHRONOUSLY, before any await can let the drain loop advance.
    expect(q.pending).toBeLessThanOrEqual(2);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0]![0]).toMatchObject({ type: '1' });
  });

  it('exposes a WriteBehindSink adapter matching the status-map seam (US-14)', async () => {
    const written: EventRecord[] = [];
    const writer: EventWriter = async (e) => {
      written.push(e);
    };
    const q = new WriteBehindEventQueue({ writer });

    // The status map calls (sessionId, status, detail). The adapter turns that
    // into a `source: 'orchestrator'` events row.
    const sink = q.transitionSink();
    sink('s9', 'awaiting_input', 'permission_prompt');

    await q.flush();

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      sessionId: 's9',
      source: 'orchestrator',
      type: 'status_transition',
      mappedStatus: 'awaiting_input',
      detail: 'permission_prompt',
    });
    await q.stop();
  });

  it('exposes a HookEventEnqueue adapter matching the hook-endpoint seam (US-15)', async () => {
    const written: EventRecord[] = [];
    const writer: EventWriter = async (e) => {
      written.push(e);
    };
    const q = new WriteBehindEventQueue({ writer });

    const enqueue = q.hookEnqueue();
    // The hook endpoint's HookEventRecord shape.
    enqueue({
      sessionId: 's3',
      source: 'hook',
      mappedStatus: 'running',
      agentEventRaw: { hook_event_name: 'PreToolUse' },
      detail: null,
    });

    await q.flush();

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      sessionId: 's3',
      source: 'hook',
      mappedStatus: 'running',
      agentEventRaw: { hook_event_name: 'PreToolUse' },
    });
    // A type is derived from the raw payload when the hook record omits one.
    expect(written[0]!.type).toBe('PreToolUse');
    await q.stop();
  });

  it('stop() flushes remaining events then halts the drain loop', async () => {
    const written: EventRecord[] = [];
    const writer: EventWriter = async (e) => {
      written.push(e);
    };
    const q = new WriteBehindEventQueue({ writer });

    q.enqueue(makeRecord({ type: 'x' }));
    await q.stop(); // graceful shutdown drains the buffer

    expect(written.map((e) => e.type)).toEqual(['x']);
    expect(q.pending).toBe(0);
  });
});
