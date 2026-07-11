/**
 * SshTransport + supervised connection — US-8 INTEGRATION test (runs under
 * `pnpm test:int`, spec §9 US-8, §15 "write the contract suite once, run twice").
 *
 * Targets the dockerized `sshd` service from docker-compose.dev.yml. The compose
 * `builder` exports:
 *   FLOCK_TEST_SSH_HOST=sshd   FLOCK_TEST_SSH_PORT=22   FLOCK_TEST_SSH_USER=flock
 * and the sshd service writes a shared ed25519 private key to /ssh-keys/id_test
 * so the builder can authenticate as `flock` over the internal `flock` network.
 *
 * Two halves:
 *   1. CONTRACT — the SAME `runTransportContract` battery that LocalTransport
 *      passes (US-7) is run against SshTransport here ("local = SSH minus the
 *      hop"). Each assertion gets a fresh transport off ONE supervised
 *      connection, exercising exec / openPty / dispose over the real ssh2 hop.
 *   2. SUPERVISION — US-8 acceptance: connecting flips the node to `connected`;
 *      a FORCED DROP flips it to `disconnected`; autossh-style supervision
 *      auto-reconnects back to `connected`.
 *
 * Nodes stay DUMB couriers (spec §4.3, §5.1): all logic — status, supervision,
 * backoff — lives here on the orchestrator side. The node only runs sshd.
 */
import { existsSync, readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SupervisedSshConnection } from './ssh-connection.js';
import { runTransportContract } from './transport-contract.js';

const HOST = process.env.FLOCK_TEST_SSH_HOST ?? 'sshd';
const PORT = Number(process.env.FLOCK_TEST_SSH_PORT ?? '22');
const USER = process.env.FLOCK_TEST_SSH_USER ?? 'flock';
const KEY_PATH = process.env.FLOCK_TEST_SSH_KEY ?? '/ssh-keys/id_test';
const SSH_FIXTURE_AVAILABLE = existsSync(KEY_PATH);

function privateKey(): Buffer {
  return readFileSync(KEY_PATH);
}

function connectConfig() {
  return {
    host: HOST,
    port: PORT,
    username: USER,
    privateKey: privateKey(),
    // Test sshd uses an ephemeral host key generated at container start.
    // Integration network is trusted; we don't pin the host key here.
  };
}

/** Waits for a supervised connection to reach a status, or rejects on timeout. */
function waitForStatus(
  conn: SupervisedSshConnection,
  status: string,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (conn.status === status) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Timed out waiting for status "${status}". Last: "${conn.status}".`));
    }, timeoutMs);
    const off = conn.onStatusChange((next) => {
      if (next === status) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 1. The shared contract battery, run against the real SSH hop.
// ---------------------------------------------------------------------------

// One probe connection proves the network/key are usable before the battery and
// fails fast (with a clear message) if the dockerized sshd / shared key volume
// isn't up. The contract battery itself uses a FRESH connection per assertion so
// each runs in full isolation — exactly like LocalTransport's `new
// LocalTransport()` per test — avoiding shared-ssh2-client listener buildup.
let probeConn: SupervisedSshConnection;
const openConnections: SupervisedSshConnection[] = [];

beforeAll(async () => {
  if (!SSH_FIXTURE_AVAILABLE) return;
  probeConn = new SupervisedSshConnection(connectConfig());
  await probeConn.connect();
}, 20_000);

afterAll(async () => {
  await probeConn?.dispose();
  await Promise.all(openConnections.map((c) => c.dispose()));
});

// Each contract assertion gets a fresh, independently-supervised connection +
// transport. The contract's `withTransport` disposes the transport after each
// test; we additionally track the connection so afterAll closes the ssh2 client.
runTransportContract(
  'SshTransport',
  async () => {
    const conn = new SupervisedSshConnection(connectConfig());
    openConnections.push(conn);
    await conn.connect();
    return conn.transport();
  },
  { skip: !SSH_FIXTURE_AVAILABLE },
);

// ---------------------------------------------------------------------------
// 2. Supervised connection — connect / forced drop / auto-reconnect (US-8).
// ---------------------------------------------------------------------------

describe.skipIf(!SSH_FIXTURE_AVAILABLE)('US-8 supervised SSH connection', () => {
  it('opens a managed connection and reports status "connected"', async () => {
    const conn = new SupervisedSshConnection(connectConfig());
    try {
      expect(['disconnected', 'connecting']).toContain(conn.status);
      await conn.connect();
      expect(conn.status).toBe('connected');
    } finally {
      await conn.dispose();
    }
  });

  it('a forced drop flips to "disconnected" then auto-reconnects to "connected"', async () => {
    const conn = new SupervisedSshConnection({
      ...connectConfig(),
      // Fast backoff so the test reconnects quickly.
      reconnect: { initialDelayMs: 200, maxDelayMs: 1000, factor: 2 },
    });
    try {
      await conn.connect();
      expect(conn.status).toBe('connected');

      const observed: string[] = [];
      const off = conn.onStatusChange((s) => observed.push(s));

      // Force the underlying socket down WITHOUT calling dispose(): the
      // supervisor must treat this as an unexpected drop (autossh behaviour),
      // not an intentional shutdown.
      conn.forceDropForTest();

      await waitForStatus(conn, 'disconnected');
      // Supervision must bring it back on its own.
      await waitForStatus(conn, 'connected');
      off();

      expect(observed).toContain('disconnected');
      expect(observed[observed.length - 1]).toBe('connected');

      // And the recovered connection is actually usable again.
      const t = conn.transport();
      const result = await t.exec(['printf', 'after-reconnect']);
      expect(result.stdout).toContain('after-reconnect');
    } finally {
      await conn.dispose();
    }
  }, 25_000);

  it('dispose() is an intentional shutdown: no auto-reconnect after it', async () => {
    const conn = new SupervisedSshConnection(connectConfig());
    await conn.connect();
    await conn.dispose();
    expect(conn.status).toBe('disconnected');

    // Give the supervisor a chance to (wrongly) reconnect.
    await new Promise((r) => setTimeout(r, 500));
    expect(conn.status).toBe('disconnected');
    // A disposed connection must refuse to hand out transports.
    expect(() => conn.transport()).toThrow();
  });

  it('a bad private key surfaces status "error" (no crash, spec §10)', async () => {
    const conn = new SupervisedSshConnection({
      ...connectConfig(),
      // Structurally-valid but unauthorized key → auth failure, not a throw.
      privateKey: Buffer.from(
        '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n',
      ),
      reconnect: { initialDelayMs: 100, maxDelayMs: 200, factor: 2, maxRetries: 1 },
    });
    try {
      await expect(conn.connect()).rejects.toBeDefined();
      expect(conn.status).toBe('error');
    } finally {
      await conn.dispose();
    }
  });
});
