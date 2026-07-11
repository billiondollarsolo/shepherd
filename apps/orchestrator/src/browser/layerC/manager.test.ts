import { describe, expect, it, vi } from 'vitest';
import { ScreencastManager } from './manager.js';
import {
  ScreencastConcurrencyError,
  type CdpScreencastClient,
  type CdpScreencastFrame,
} from './types.js';
import { decodeScreencastFrame } from './protocol.js';

/**
 * US-27 — Layer C screencast view (FR-B3, NFR-PERF3).
 *
 * Acceptance: `Page.startScreencast` frames stream over `screencast:<id>` to the
 * Browser tab **on demand only** — start on tab open, stop on tab switch.
 *
 * These tests pin the on-demand start/stop semantics + frame forwarding + ack
 * back-pressure with a fake CDP client and a fake sink (no real chrome / ws).
 */

interface FakeClient extends CdpScreencastClient {
  startCalls: number;
  stopCalls: number;
  acked: number[];
  emit(frame: CdpScreencastFrame): void;
  listenerCount(): number;
  closed: boolean;
}

function makeFakeClient(): FakeClient {
  const listeners = new Set<(f: CdpScreencastFrame) => void>();
  const client: FakeClient = {
    startCalls: 0,
    stopCalls: 0,
    acked: [],
    closed: false,
    Page: {
      async startScreencast() {
        client.startCalls += 1;
      },
      async stopScreencast() {
        client.stopCalls += 1;
      },
      async screencastFrameAck({ sessionId }) {
        client.acked.push(sessionId);
      },
      screencastFrame(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(frame) {
      for (const l of [...listeners]) l(frame);
    },
    listenerCount() {
      return listeners.size;
    },
    async close() {
      client.closed = true;
    },
  };
  return client;
}

function makeFakeSink(): {
  send: ReturnType<typeof vi.fn>;
  sent: Array<{ sessionId: string; payload: string }>;
} {
  const sent: Array<{ sessionId: string; payload: string }> = [];
  const send = vi.fn((sessionId: string, payload: string) => {
    sent.push({ sessionId, payload });
  });
  return { send, sent };
}

function frame(n: number): CdpScreencastFrame {
  return {
    data: `aGVsbG8${n}`, // base64-ish
    sessionId: n,
    metadata: {
      offsetTop: 0,
      pageScaleFactor: 1,
      deviceWidth: 1280,
      deviceHeight: 720,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
      timestamp: 1000 + n,
    },
  };
}

const SID = '11111111-1111-4111-8111-111111111111';

describe('ScreencastManager — on-demand start/stop (US-27)', () => {
  it('does NOT start a screencast until a viewer opens the tab (on-demand)', () => {
    const client = makeFakeClient();
    const sink = makeFakeSink();
    new ScreencastManager({
      resolveClient: async () => client,
      sink,
    });
    // Manager constructed but nobody opened a tab → no CDP call at all.
    expect(client.startCalls).toBe(0);
    expect(client.listenerCount()).toBe(0);
  });

  it('calls Page.startScreencast exactly once when the tab opens', async () => {
    const client = makeFakeClient();
    const sink = makeFakeSink();
    const mgr = new ScreencastManager({ resolveClient: async () => client, sink });

    await mgr.start(SID);

    expect(client.startCalls).toBe(1);
    expect(client.listenerCount()).toBe(1);
    expect(mgr.isStreaming(SID)).toBe(true);
  });

  it('is idempotent: a second start() for an open tab does not re-issue startScreencast', async () => {
    const client = makeFakeClient();
    const sink = makeFakeSink();
    const mgr = new ScreencastManager({ resolveClient: async () => client, sink });

    await mgr.start(SID);
    await mgr.start(SID);

    expect(client.startCalls).toBe(1);
  });

  it('forwards each CDP frame to screencast:<id> AND acks it (back-pressure)', async () => {
    const client = makeFakeClient();
    const sink = makeFakeSink();
    const mgr = new ScreencastManager({ resolveClient: async () => client, sink });

    await mgr.start(SID);
    client.emit(frame(1));
    client.emit(frame(2));

    // Forwarded to the sink on the right channel id.
    expect(sink.send).toHaveBeenCalledTimes(2);
    expect(sink.sent[0].sessionId).toBe(SID);

    const decoded = decodeScreencastFrame(sink.sent[0].payload);
    expect(decoded.type).toBe('frame');
    expect(decoded.sessionId).toBe(SID);
    expect(decoded.data).toBe('aGVsbG81');
    expect(decoded.metadata.deviceWidth).toBe(1280);

    // Every frame is acked with its CDP frame ordinal so chrome sends the next.
    expect(client.acked).toEqual([1, 2]);
  });

  it('stops on tab switch: Page.stopScreencast called and NO further frames forwarded', async () => {
    const client = makeFakeClient();
    const sink = makeFakeSink();
    const mgr = new ScreencastManager({ resolveClient: async () => client, sink });

    await mgr.start(SID);
    client.emit(frame(1));
    expect(sink.send).toHaveBeenCalledTimes(1);

    await mgr.stop(SID);

    expect(client.stopCalls).toBe(1);
    expect(client.listenerCount()).toBe(0);
    expect(mgr.isStreaming(SID)).toBe(false);

    // Late frames after stop must not reach the sink.
    client.emit(frame(2));
    expect(sink.send).toHaveBeenCalledTimes(1);
  });

  it('stop() is a no-op (and does not call stopScreencast) when not streaming', async () => {
    const client = makeFakeClient();
    const sink = makeFakeSink();
    const mgr = new ScreencastManager({ resolveClient: async () => client, sink });

    await mgr.stop(SID);
    expect(client.stopCalls).toBe(0);
  });

  it('passes the configured JPEG quality + format to startScreencast (NFR-PERF3)', async () => {
    const client = makeFakeClient();
    const startSpy = vi.spyOn(client.Page, 'startScreencast');
    const sink = makeFakeSink();
    const mgr = new ScreencastManager({
      resolveClient: async () => client,
      sink,
      config: { quality: 42, format: 'jpeg' },
    });

    await mgr.start(SID);

    expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({ format: 'jpeg', quality: 42 }));
  });

  it('lets quality be adjusted live and applies it on the next (re)start (NFR-PERF3)', async () => {
    const client = makeFakeClient();
    const startSpy = vi.spyOn(client.Page, 'startScreencast');
    const sink = makeFakeSink();
    const mgr = new ScreencastManager({ resolveClient: async () => client, sink });

    await mgr.start(SID);
    mgr.setQuality(SID, 10);
    await mgr.stop(SID);
    await mgr.start(SID);

    expect(startSpy).toHaveBeenLastCalledWith(expect.objectContaining({ quality: 10 }));
  });

  it('enforces a concurrent active-stream cap (NFR-PERF3, spec §10)', async () => {
    const sink = makeFakeSink();
    const mgr = new ScreencastManager({
      resolveClient: async () => makeFakeClient(),
      sink,
      config: { maxConcurrentStreams: 1 },
    });

    await mgr.start('aaaaaaaa-1111-4111-8111-111111111111');
    await expect(mgr.start('bbbbbbbb-2222-4222-8222-222222222222')).rejects.toBeInstanceOf(
      ScreencastConcurrencyError,
    );
  });

  it('stopAll() stops every active stream (orchestrator shutdown)', async () => {
    const clients = new Map<string, FakeClient>();
    const sink = makeFakeSink();
    const mgr = new ScreencastManager({
      resolveClient: async (id) => {
        const c = makeFakeClient();
        clients.set(id, c);
        return c;
      },
      sink,
      config: { maxConcurrentStreams: 5 },
    });
    const a = 'aaaaaaaa-1111-4111-8111-111111111111';
    const b = 'bbbbbbbb-2222-4222-8222-222222222222';
    await mgr.start(a);
    await mgr.start(b);

    await mgr.stopAll();

    expect(clients.get(a)!.stopCalls).toBe(1);
    expect(clients.get(b)!.stopCalls).toBe(1);
    expect(mgr.activeCount()).toBe(0);
  });
});
