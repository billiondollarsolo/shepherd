/**
 * US-11 — PtyWsServer unit tests (run under `pnpm test:unit`).
 *
 * Drives the bridge over REAL `ws` sockets on a loopback http.Server, but with a
 * FAKE transport (no tmux) so it stays a fast unit test. Asserts the acceptance
 * criteria at the wire level:
 *   - binary frames carry PTY output (server→client) and input (client→server),
 *   - TWO clients on the same `/ws/pty/:id` both receive output (FR-S6),
 *   - a reconnecting client RESUMES from the recent-output buffer (US-11),
 *   - JSON control frames are validated with the SHARED zod ClientMessage and
 *     produce the SHARED PtyControlMessage acks,
 *   - the optional auth gate rejects an unauthenticated upgrade (NFR-SEC6),
 *   - URL parsing extracts the session id.
 *
 * Frame timing: `ws` does NOT replay messages to listeners attached after the
 * frame arrived, and the server AUTO-subscribes on connect (so the 'attached'
 * control + the resume replay can land the instant the socket opens). To avoid a
 * listener-attach race, every test socket is wrapped in a {@link Recorder} whose
 * `message` listener is registered SYNCHRONOUSLY at construction; assertions then
 * poll the recorded frames rather than racing a one-shot listener.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { type AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type {
  ExecOptions,
  ExecResult,
  NodeTransport,
  OpenPtyOptions,
  PtyExit,
  PtyHandle,
} from '../../nodes/transport/transport.js';
import { PtySessionRegistry } from './pty-session-registry.js';
import {
  PtyWsServer,
  parseSessionIdFromUrl,
  parseInitialSizeFromUrl,
  PTY_WS_PATH_PREFIX,
} from './pty-ws-server.js';

class FakePtyHandle implements PtyHandle {
  private readonly dataListeners = new Set<(c: string) => void>();
  private readonly exitListeners = new Set<(e: PtyExit) => void>();
  readonly writes: string[] = [];
  onData(l: (c: string) => void): () => void {
    this.dataListeners.add(l);
    return () => this.dataListeners.delete(l);
  }
  onExit(l: (e: PtyExit) => void): () => void {
    this.exitListeners.add(l);
    return () => this.exitListeners.delete(l);
  }
  write(d: string): void {
    this.writes.push(d);
  }
  resize(): void {}
  kill(): void {}
  emit(chunk: string): void {
    for (const l of [...this.dataListeners]) l(chunk);
  }
  exit(e: PtyExit = { exitCode: 0, signal: null }): void {
    for (const l of [...this.exitListeners]) l(e);
  }
}

class FakeTransport implements NodeTransport {
  readonly kind = 'local' as const;
  readonly ptys: FakePtyHandle[] = [];
  async exec(_c: string[], _o?: ExecOptions): Promise<ExecResult> {
    return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
  }
  async openPty(_o?: OpenPtyOptions): Promise<PtyHandle> {
    const p = new FakePtyHandle();
    this.ptys.push(p);
    return p;
  }
  async dispose(): Promise<void> {}
}

const ID = '44444444-4444-4444-8444-444444444444';

interface Harness {
  http: HttpServer;
  port: number;
  bridge: PtyWsServer;
  transport: FakeTransport;
}

async function startHarness(authOk = true): Promise<Harness> {
  const transport = new FakeTransport();
  const registry = new PtySessionRegistry({
    resolve: () => ({
      transport,
      attachCommand: () => ['tmux', 'attach-session', '-t', `flock-${ID}`],
      workingDir: '/w',
    }),
  });
  const bridge = new PtyWsServer({
    registry,
    authenticate: () => authOk,
  });
  const http = createServer();
  bridge.attach(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  return { http, port, bridge, transport };
}

let harness: Harness | null = null;
beforeEach(async () => {
  harness = await startHarness();
});
afterEach(async () => {
  for (const r of openRecorders) r.ws.close();
  openRecorders.length = 0;
  harness?.bridge.close();
  await new Promise<void>((resolve) => harness?.http.close(() => resolve()));
  harness = null;
});

const openRecorders: Recorder[] = [];

/**
 * Wraps a WebSocket and records EVERY frame from the moment of construction, so
 * tests never miss a frame that arrives before a listener is attached.
 */
class Recorder {
  readonly ws: WebSocket;
  readonly binary: Buffer[] = [];
  readonly control: Array<Record<string, unknown>> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.binary.push(data);
      } else {
        this.control.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
      }
    });
    openRecorders.push(this);
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  binaryText(): string {
    return Buffer.concat(this.binary).toString('utf8');
  }

  send(data: Buffer | string, binary: boolean): void {
    this.ws.send(data, { binary });
  }
}

function connect(h: Harness): Recorder {
  return new Recorder(`ws://127.0.0.1:${h.port}${PTY_WS_PATH_PREFIX}${ID}`);
}

/** Poll until `predicate` holds or time runs out. */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timeout waiting for condition');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('parseSessionIdFromUrl', () => {
  it('extracts the id from /ws/pty/<id>', () => {
    expect(parseSessionIdFromUrl(`${PTY_WS_PATH_PREFIX}${ID}`)).toBe(ID);
    expect(parseSessionIdFromUrl(`${PTY_WS_PATH_PREFIX}${ID}?token=x`)).toBe(ID);
  });
  it('returns null for non-pty paths and malformed ids', () => {
    expect(parseSessionIdFromUrl('/ws/status')).toBeNull();
    expect(parseSessionIdFromUrl(PTY_WS_PATH_PREFIX)).toBeNull();
    expect(parseSessionIdFromUrl(`${PTY_WS_PATH_PREFIX}${ID}/extra`)).toBeNull();
    expect(parseSessionIdFromUrl(undefined)).toBeNull();
  });
});

describe('parseInitialSizeFromUrl', () => {
  it('parses ?cols=&rows= into an initial size', () => {
    expect(parseInitialSizeFromUrl(`${PTY_WS_PATH_PREFIX}${ID}?cols=142&rows=48`)).toEqual({
      cols: 142,
      rows: 48,
    });
  });
  it('returns null when absent or invalid, and caps absurd values', () => {
    expect(parseInitialSizeFromUrl(`${PTY_WS_PATH_PREFIX}${ID}`)).toBeNull();
    expect(parseInitialSizeFromUrl(`${PTY_WS_PATH_PREFIX}${ID}?cols=0&rows=10`)).toBeNull();
    expect(parseInitialSizeFromUrl(`${PTY_WS_PATH_PREFIX}${ID}?cols=abc&rows=10`)).toBeNull();
    expect(parseInitialSizeFromUrl(undefined)).toBeNull();
    expect(parseInitialSizeFromUrl(`${PTY_WS_PATH_PREFIX}${ID}?cols=99999&rows=99999`)).toEqual({
      cols: 1000,
      rows: 1000,
    });
  });
});

describe('PtyWsServer — streaming + binary framing (US-11)', () => {
  it('sends an attached control frame on connect (auto-subscribe)', async () => {
    const h = harness!;
    const ws = connect(h);
    await ws.open();
    await waitUntil(() => ws.control.some((c) => c.op === 'attached'));
    expect(ws.control.find((c) => c.op === 'attached')).toMatchObject({
      channel: 'pty',
      sessionId: ID,
      op: 'attached',
    });
  });

  it('streams PTY output to the client as binary frames', async () => {
    const h = harness!;
    const ws = connect(h);
    await ws.open();
    await waitUntil(() => h.transport.ptys.length === 1);
    h.transport.ptys[0]!.emit('booting...\n');
    await waitUntil(() => ws.binaryText().includes('booting'));
    expect(ws.binaryText()).toContain('booting...\n');
  });

  it('forwards client binary input INTO the PTY', async () => {
    const h = harness!;
    const ws = connect(h);
    await ws.open();
    await waitUntil(() => h.transport.ptys.length === 1);
    ws.send(Buffer.from('echo hi\r'), true);
    await waitUntil(() => h.transport.ptys[0]!.writes.includes('echo hi\r'));
    expect(h.transport.ptys[0]!.writes).toContain('echo hi\r');
  });

  it('TWO clients on the same session BOTH receive output (FR-S6)', async () => {
    const h = harness!;
    const a = connect(h);
    const b = connect(h);
    await Promise.all([a.open(), b.open()]);
    // Both attach to the ONE shared PTY.
    await waitUntil(
      () =>
        a.control.some((c) => c.op === 'attached') && b.control.some((c) => c.op === 'attached'),
    );
    expect(h.transport.ptys).toHaveLength(1);

    h.transport.ptys[0]!.emit('multi-client\n');
    await waitUntil(() => a.binaryText().includes('multi') && b.binaryText().includes('multi'));
    expect(a.binaryText()).toContain('multi-client\n');
    expect(b.binaryText()).toContain('multi-client\n');
  });
});

describe('PtyWsServer — reconnect resume (US-11)', () => {
  it('replays the recent-output buffer to a reconnecting client', async () => {
    const h = harness!;
    const first = connect(h);
    await first.open();
    await waitUntil(() => h.transport.ptys.length === 1);
    h.transport.ptys[0]!.emit('persisted-line\n');
    await waitUntil(() => first.binaryText().includes('persisted'));

    // Disconnect; wait for the server to observe the close (last subscriber gone).
    first.ws.close();
    await new Promise((r) => setTimeout(r, 100));

    // Reconnect: the new socket must receive the backlog WITHOUT the producer
    // emitting anything new. (A fresh PTY is opened; its resume buffer carries
    // the bytes produced before the disconnect.)
    const again = connect(h);
    await again.open();
    await waitUntil(() => again.binaryText().includes('persisted'));
    expect(again.binaryText()).toContain('persisted-line\n');
  });
});

describe('PtyWsServer — shared zod control protocol', () => {
  it('acks pty:resize with a shared PtyControlMessage and resizes', async () => {
    const h = harness!;
    const ws = connect(h);
    await ws.open();
    await waitUntil(() => ws.control.some((c) => c.op === 'attached'));
    ws.send(JSON.stringify({ op: 'pty:resize', sessionId: ID, cols: 100, rows: 30 }), false);
    await waitUntil(() => ws.control.some((c) => c.op === 'resize'));
    expect(ws.control.find((c) => c.op === 'resize')).toMatchObject({
      channel: 'pty',
      sessionId: ID,
      op: 'resize',
      cols: 100,
      rows: 30,
    });
  });

  it('ignores malformed / non-conforming control frames', async () => {
    const h = harness!;
    const ws = connect(h);
    await ws.open();
    await waitUntil(() => h.transport.ptys.length === 1);
    ws.send('not json{', false);
    ws.send(JSON.stringify({ op: 'bogus' }), false);
    // Still streaming fine afterwards.
    h.transport.ptys[0]!.emit('alive\n');
    await waitUntil(() => ws.binaryText().includes('alive'));
    expect(ws.binaryText()).toContain('alive');
  });

  it('sends an `exited` control frame (with exit code) and closes when the PTY exits', async () => {
    const h = harness!;
    const ws = connect(h);
    await ws.open();
    await waitUntil(() => h.transport.ptys.length === 1);
    const closed = new Promise<void>((resolve) => ws.ws.once('close', () => resolve()));
    h.transport.ptys[0]!.exit({ exitCode: 0, signal: null });
    await closed;
    // Terminal exit (NOT `detached`) so the client stops reconnecting.
    const exited = ws.control.find((c) => c.op === 'exited');
    expect(exited).toBeDefined();
    expect(exited?.exitCode).toBe(0);
  });

  it('a TRANSIENT exit (node link drop) closes WITHOUT `exited` so the client reconnects', async () => {
    const h = harness!;
    const ws = connect(h);
    await ws.open();
    await waitUntil(() => h.transport.ptys.length === 1);
    const closed = new Promise<void>((resolve) => ws.ws.once('close', () => resolve()));
    h.transport.ptys[0]!.exit({ exitCode: -1, signal: null, transient: true });
    await closed;
    // No `exited` frame → the browser treats it as a normal close and reconnects
    // (the agent persists on the daemon; the link will be rebuilt).
    expect(ws.control.find((c) => c.op === 'exited')).toBeUndefined();
  });
});

describe('PtyWsServer — auth gate (NFR-SEC6)', () => {
  it('rejects the upgrade when authenticate returns false', async () => {
    const denied = await startHarness(false);
    const ws = new WebSocket(`ws://127.0.0.1:${denied.port}${PTY_WS_PATH_PREFIX}${ID}`);
    const result = await new Promise<'open' | 'rejected'>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('rejected'));
      ws.once('unexpected-response', () => resolve('rejected'));
    });
    expect(result).toBe('rejected');
    denied.bridge.close();
    await new Promise<void>((r) => denied.http.close(() => r()));
  });
});
