import { describe, expect, it, vi } from 'vitest';
import type { StatusUpdateMessage } from '@flock/shared';
import { StatusMap } from './map.js';
import { StatusChannel, type StatusSocket } from './channel.js';

/**
 * US-14 — the `status` WS channel (spec §8.2).
 *
 * Every status transition fans out `{channel:'status', sessionId, status,
 * detail, ts}` to all sockets currently subscribed to the `status` channel.
 * The channel is a thin adapter over {@link StatusMap}'s subscribe hook; it owns
 * NO source of truth and never touches the DB.
 */

const TS = '2026-05-29T05:00:00.000Z';

/** A fake socket capturing the JSON frames it would send to a client. */
function fakeSocket(): StatusSocket & { sent: string[]; open: boolean } {
  const sent: string[] = [];
  return {
    sent,
    open: true,
    get readyState() {
      return this.open ? 1 : 3; // ws.OPEN : ws.CLOSED
    },
    send(data: string) {
      sent.push(data);
    },
  };
}

function parse(frames: string[]): StatusUpdateMessage[] {
  return frames.map((f) => JSON.parse(f) as StatusUpdateMessage);
}

describe('StatusChannel — `status` WS fan-out (US-14)', () => {
  it('forwards every transition to subscribed sockets as status frames', () => {
    const map = new StatusMap({ clock: () => TS });
    const channel = new StatusChannel(map);
    const sock = fakeSocket();
    channel.add(sock);

    map.set('s1', 'awaiting_input', 'permission_prompt');

    expect(parse(sock.sent)).toEqual<StatusUpdateMessage[]>([
      {
        channel: 'status',
        sessionId: 's1',
        status: 'awaiting_input',
        detail: 'permission_prompt',
        ts: TS,
      },
    ]);
  });

  it('fans out to multiple subscribed sockets', () => {
    const map = new StatusMap({ clock: () => TS });
    const channel = new StatusChannel(map);
    const a = fakeSocket();
    const b = fakeSocket();
    channel.add(a);
    channel.add(b);

    map.set('s1', 'running');

    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it('removed sockets stop receiving frames', () => {
    const map = new StatusMap({ clock: () => TS });
    const channel = new StatusChannel(map);
    const sock = fakeSocket();
    channel.add(sock);

    map.set('s1', 'running');
    channel.remove(sock);
    map.set('s1', 'idle');

    expect(sock.sent).toHaveLength(1);
  });

  it('skips sockets that are not OPEN (closed/closing)', () => {
    const map = new StatusMap({ clock: () => TS });
    const channel = new StatusChannel(map);
    const sock = fakeSocket();
    channel.add(sock);
    sock.open = false; // now CLOSED

    map.set('s1', 'running');

    expect(sock.sent).toHaveLength(0);
  });

  it('a throwing socket.send does not block other sockets', () => {
    const map = new StatusMap({ clock: () => TS });
    const channel = new StatusChannel(map);
    const bad = fakeSocket();
    bad.send = () => {
      throw new Error('socket exploded');
    };
    const good = fakeSocket();
    channel.add(bad);
    channel.add(good);

    expect(() => map.set('s1', 'error')).not.toThrow();
    expect(good.sent).toHaveLength(1);
  });

  it('close() detaches from the map so no further frames are produced', () => {
    const map = new StatusMap({ clock: () => TS });
    const channel = new StatusChannel(map);
    const sock = fakeSocket();
    channel.add(sock);

    channel.close();
    map.set('s1', 'running');

    expect(sock.sent).toHaveLength(0);
  });

  it('does NOT read the DB to fan out (no async work on the path)', () => {
    // The channel has no DB handle at all; constructing it requires only the
    // in-memory map. This is the structural guarantee for NFR-PERF1: the WS
    // path literally cannot touch Postgres.
    const map = new StatusMap({ clock: () => TS });
    const channel = new StatusChannel(map);
    const sock = fakeSocket();
    channel.add(sock);

    const spy = vi.fn();
    // Patch send to be observably synchronous relative to set().
    sock.send = (data: string) => {
      spy();
      sock.sent.push(data);
    };

    map.set('s1', 'running');
    // Frame delivered synchronously within set() — no awaited DB round-trip.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
