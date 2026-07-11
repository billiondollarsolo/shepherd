/**
 * SupervisedSshConnection — UNIT test of the autossh-style supervision STATE
 * MACHINE (US-8), runs under `pnpm test:unit`. No real sshd: a fake connector is
 * injected so the connect / drop / reconnect / backoff / shutdown transitions
 * are tested deterministically and fast. The real-ssh path is covered by
 * ssh-transport.int.test.ts.
 *
 * The status vocabulary MUST be the shared ConnectionStatusEnum
 * (connected | connecting | disconnected | error) from @flock/shared — never a
 * locally-redefined set (spec: types live in packages/shared, imported by both).
 */
import { ConnectionStatusEnum } from '@flock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SupervisedSshConnection,
  sshHostKeyFingerprint,
  type SshConnector,
  type ManagedClient,
} from './ssh-connection.js';
import { createHash } from 'node:crypto';

/** A controllable fake of the live ssh2 client the connector yields. */
class FakeManagedClient implements ManagedClient {
  closeListeners = new Set<(hadError: boolean) => void>();
  ended = false;

  onClose(listener: (hadError: boolean) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  end(): void {
    this.ended = true;
  }

  /** Test helper: simulate the transport layer dropping the link. */
  emitClose(hadError = true): void {
    for (const l of [...this.closeListeners]) l(hadError);
  }

  // These unit tests exercise the supervision STATE MACHINE, never the wire
  // transport (that is covered by ssh-transport.int.test.ts against real sshd),
  // so makeTransport is intentionally unreachable here.
  makeTransport(): never {
    throw new Error('makeTransport is not used in supervision unit tests');
  }
}

describe('sshHostKeyFingerprint (T7)', () => {
  it('produces an OpenSSH-style SHA256 fingerprint with no padding', () => {
    const key = Buffer.from('a fake host public key', 'utf8');
    const fp = sshHostKeyFingerprint(key);
    const expected =
      'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
    expect(fp).toBe(expected);
    expect(fp.startsWith('SHA256:')).toBe(true);
    expect(fp.endsWith('=')).toBe(false);
  });

  it('is deterministic and distinguishes different keys', () => {
    const a = Buffer.from('key-a');
    const b = Buffer.from('key-b');
    expect(sshHostKeyFingerprint(a)).toBe(sshHostKeyFingerprint(a));
    expect(sshHostKeyFingerprint(a)).not.toBe(sshHostKeyFingerprint(b));
  });
});

/**
 * T7 — trust-on-first-use host-key pin. This is the same closure shape the
 * connection manager builds: first unseen key is pinned (persist + accept),
 * a matching key on reconnect is accepted, a changed key is rejected.
 */
describe('host-key TOFU verifier (T7)', () => {
  function makeVerifier(initial: string | null) {
    let pinned = initial;
    const persisted: string[] = [];
    const verify = async (fp: string): Promise<boolean> => {
      if (!pinned) {
        pinned = fp;
        persisted.push(fp);
        return true;
      }
      return pinned === fp;
    };
    return { verify, persisted, current: () => pinned };
  }

  it('pins on first use, accepts the same key, rejects a changed key', async () => {
    const v = makeVerifier(null);
    expect(await v.verify('SHA256:aaa')).toBe(true); // first use → pin
    expect(v.persisted).toEqual(['SHA256:aaa']);
    expect(v.current()).toBe('SHA256:aaa');
    expect(await v.verify('SHA256:aaa')).toBe(true); // reconnect, same key
    expect(await v.verify('SHA256:bbb')).toBe(false); // MITM / changed key
    expect(v.persisted).toEqual(['SHA256:aaa']); // not re-persisted
  });

  it('honours a pre-existing pin from the DB row', async () => {
    const v = makeVerifier('SHA256:stored');
    expect(await v.verify('SHA256:stored')).toBe(true);
    expect(await v.verify('SHA256:evil')).toBe(false);
    expect(v.persisted).toEqual([]); // already pinned → never writes
  });
});

/** Builds a connector that hands out fresh fake clients, recording each. */
function fakeConnector(opts?: { failTimes?: number; failWith?: Error }): {
  connector: SshConnector;
  clients: FakeManagedClient[];
  attempts: () => number;
} {
  const clients: FakeManagedClient[] = [];
  let attempts = 0;
  let remainingFailures = opts?.failTimes ?? 0;
  const connector: SshConnector = async () => {
    attempts += 1;
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      throw opts?.failWith ?? new Error('connect refused');
    }
    const client = new FakeManagedClient();
    clients.push(client);
    return client;
  };
  return { connector, clients, attempts: () => attempts };
}

const cfg = { host: 'node-1', port: 22, username: 'flock', privateKey: Buffer.from('k') };

describe('SupervisedSshConnection — supervision state machine (US-8)', () => {
  // Tests that use fake timers must not leak scheduled reconnects into the next
  // test; restore real timers (clearing any pending fake timers) after each.
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('uses ONLY the shared ConnectionStatusEnum vocabulary', () => {
    const conn = new SupervisedSshConnection(cfg, fakeConnector().connector);
    // The initial status must be a member of the shared enum.
    expect(ConnectionStatusEnum.options).toContain(conn.status);
  });

  it('starts disconnected, goes connecting then connected on connect()', async () => {
    const { connector } = fakeConnector();
    const conn = new SupervisedSshConnection(cfg, connector);
    const seen: string[] = [];
    conn.onStatusChange((s) => seen.push(s));

    expect(conn.status).toBe('disconnected');
    await conn.connect();
    expect(conn.status).toBe('connected');
    expect(seen).toEqual(['connecting', 'connected']);
    await conn.dispose();
  });

  it('an unexpected drop flips to disconnected then auto-reconnects to connected', async () => {
    vi.useFakeTimers();
    try {
      const { connector, clients } = fakeConnector();
      const conn = new SupervisedSshConnection(cfg, connector, {
        initialDelayMs: 100,
        maxDelayMs: 1000,
        factor: 2,
      });
      await conn.connect();
      const seen: string[] = [];
      conn.onStatusChange((s) => seen.push(s));

      // Transport-level drop (NOT dispose) → autossh behaviour.
      clients[0]!.emitClose(true);
      expect(conn.status).toBe('disconnected');

      // Backoff timer elapses → a new connect attempt → connected again.
      await vi.advanceTimersByTimeAsync(150);
      expect(conn.status).toBe('connected');
      expect(seen).toEqual(['disconnected', 'connecting', 'connected']);
      expect(clients).toHaveLength(2);

      await conn.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies exponential backoff between failed reconnect attempts', async () => {
    vi.useFakeTimers();
    try {
      // First connect succeeds; after a drop the next 2 connects fail, 3rd works.
      const clients: FakeManagedClient[] = [];
      let attempts = 0;
      let dropFails = 0;
      const connector: SshConnector = async () => {
        attempts += 1;
        if (attempts === 1) {
          const c = new FakeManagedClient();
          clients.push(c);
          return c;
        }
        // Reconnect attempts: fail twice, then succeed.
        if (dropFails < 2) {
          dropFails += 1;
          throw new Error('still down');
        }
        const c = new FakeManagedClient();
        clients.push(c);
        return c;
      };
      const conn = new SupervisedSshConnection(cfg, connector, {
        initialDelayMs: 100,
        maxDelayMs: 10_000,
        factor: 2,
      });
      await conn.connect();
      clients[0]!.emitClose(true);
      expect(conn.status).toBe('disconnected');

      // Attempt #2 after 100ms → fails, stays disconnected.
      await vi.advanceTimersByTimeAsync(100);
      expect(conn.status).toBe('disconnected');
      // Attempt #3 after 200ms (backoff x2) → fails, stays disconnected.
      await vi.advanceTimersByTimeAsync(200);
      expect(conn.status).toBe('disconnected');
      // Attempt #4 after 400ms (backoff x2) → succeeds.
      await vi.advanceTimersByTimeAsync(400);
      expect(conn.status).toBe('connected');

      await conn.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('connect() rejects and sets status "error" when the initial connect fails', async () => {
    const { connector } = fakeConnector({ failTimes: 99, failWith: new Error('bad key') });
    const conn = new SupervisedSshConnection(cfg, connector, {
      initialDelayMs: 50,
      maxDelayMs: 50,
      factor: 1,
      maxRetries: 0,
    });
    await expect(conn.connect()).rejects.toThrow('bad key');
    expect(conn.status).toBe('error');
    await conn.dispose();
  });

  it('initial connect failure still schedules reconnect so a node can come online later', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const connector: SshConnector = async () => {
        attempts += 1;
        // Offline at boot: first two dials fail; third succeeds (VM powered on).
        if (attempts < 3) throw new Error('ENETUNREACH');
        return new FakeManagedClient();
      };
      const conn = new SupervisedSshConnection(cfg, connector, {
        initialDelayMs: 100,
        maxDelayMs: 1000,
        factor: 2,
      });
      await expect(conn.connect()).rejects.toThrow('ENETUNREACH');
      expect(conn.status).toBe('error');
      expect(attempts).toBe(1);

      // First scheduled retry after 100ms → still fails.
      await vi.advanceTimersByTimeAsync(100);
      expect(attempts).toBe(2);
      expect(conn.status).toBe('disconnected');

      // Second retry after 200ms backoff → online.
      await vi.advanceTimersByTimeAsync(200);
      expect(attempts).toBe(3);
      expect(conn.status).toBe('connected');

      await conn.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose() is intentional shutdown: status disconnected, no reconnect', async () => {
    vi.useFakeTimers();
    try {
      const { connector, clients, attempts } = fakeConnector();
      const conn = new SupervisedSshConnection(cfg, connector, {
        initialDelayMs: 100,
        maxDelayMs: 1000,
        factor: 2,
      });
      await conn.connect();
      const attemptsAfterConnect = attempts();
      await conn.dispose();
      expect(conn.status).toBe('disconnected');
      expect(clients[0]!.ended).toBe(true);

      // No supervisor-driven reconnect after an intentional dispose.
      await vi.advanceTimersByTimeAsync(5000);
      expect(attempts()).toBe(attemptsAfterConnect);
      expect(conn.status).toBe('disconnected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('transport() throws after dispose', async () => {
    const conn = new SupervisedSshConnection(cfg, fakeConnector().connector);
    await conn.connect();
    await conn.dispose();
    expect(() => conn.transport()).toThrow();
  });

  it('onStatusChange unsubscribe stops further delivery', async () => {
    const { connector } = fakeConnector();
    const conn = new SupervisedSshConnection(cfg, connector);
    const seen: string[] = [];
    const off = conn.onStatusChange((s) => seen.push(s));
    off();
    await conn.connect();
    expect(seen).toEqual([]);
    await conn.dispose();
  });
});
