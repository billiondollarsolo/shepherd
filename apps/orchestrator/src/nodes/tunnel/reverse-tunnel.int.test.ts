/**
 * ReverseTunnel — US-9 INTEGRATION test (runs under `pnpm test:int`, spec §9
 * US-9; FR-N3; NFR-SEC4). Targets the dockerized `sshd` service from
 * docker-compose.dev.yml (same fixtures as ssh-transport.int.test.ts):
 *   FLOCK_TEST_SSH_HOST=sshd  FLOCK_TEST_SSH_PORT=22  FLOCK_TEST_SSH_USER=flock
 *   private key at /ssh-keys/id_test
 *
 * Acceptance criteria proven here:
 *   1. An `ssh -R` loopback-bound tunnel is established over the node's SSH
 *      connection, and a `curl localhost:<port>` ON THE NODE reaches the
 *      orchestrator hook endpoint (a stub HTTP server in this test process).
 *   2. The tunnel binds to LOOPBACK only (no GatewayPorts): the forwarded port is
 *      NOT reachable on the node's external interface — proven by a failed
 *      external-interface connect (and, when the tools exist, by inspecting the
 *      node's listening sockets via ss/netstat).
 *
 * The node stays a DUMB COURIER: it only runs sshd + curl. All tunnel logic runs
 * here on the orchestrator side over the managed ssh2 connection.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

import { Client } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ReverseTunnel } from './reverse-tunnel.js';
import { sshTunnelHost } from './ssh-tunnel-host.js';

const HOST = process.env.FLOCK_TEST_SSH_HOST ?? 'sshd';
const PORT = Number(process.env.FLOCK_TEST_SSH_PORT ?? '22');
const USER = process.env.FLOCK_TEST_SSH_USER ?? 'flock';
const KEY_PATH = process.env.FLOCK_TEST_SSH_KEY ?? '/ssh-keys/id_test';

/** Open a raw ssh2 Client to the dockerized node (mirrors the connector in transport). */
function openClient(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.on('ready', () => resolve(client));
    client.on('error', reject);
    client.connect({
      host: HOST,
      port: PORT,
      username: USER,
      privateKey: readFileSync(KEY_PATH),
      readyTimeout: 15_000,
    });
  });
}

/** Run a command on the node over a one-shot exec channel; capture stdout/code. */
function nodeExec(
  client: Client,
  command: string,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, channel) => {
      if (err) {
        reject(err);
        return;
      }
      let stdout = '';
      let code: number | null = null;
      channel.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
      });
      channel.on('exit', (c: number | null) => {
        code = c;
      });
      channel.on('close', () => resolve({ stdout, code }));
      channel.on('error', reject);
    });
  });
}

let client: Client;
let hookServer: Server;
let hookPort: number;
const hookHits: Array<{ url: string; body: string }> = [];

beforeAll(async () => {
  // Stub orchestrator hook endpoint. The tunnel pipes node-side hook curls here
  // (POST /api/hooks/:sessionId, spec §8.1). Bind on all interfaces so the dial
  // target (127.0.0.1) inside the builder reliably reaches it regardless of how
  // loopback is configured in the container; the tunnel itself still DIALS
  // 127.0.0.1 (production dials the orchestrator's own loopback hook port).
  hookServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      hookHits.push({ url: req.url ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => hookServer.listen(0, '0.0.0.0', resolve));
  hookPort = (hookServer.address() as AddressInfo).port;

  client = await openClient();
}, 25_000);

afterAll(async () => {
  client?.end();
  await new Promise<void>((resolve) => hookServer?.close(() => resolve()));
});

describe('US-9 reverse tunnel for hooks', () => {
  it('a curl localhost:<port> on the NODE reaches the orchestrator hook endpoint', async () => {
    const tunnel = new ReverseTunnel(sshTunnelHost(client), {
      host: '127.0.0.1',
      port: hookPort,
    });
    const remotePort = await tunnel.start();
    try {
      expect(remotePort).toBeGreaterThan(0);

      // The node curls its OWN loopback; sshd forwards it back to us over the
      // existing SSH connection, and the tunnel pipes it to the hook endpoint.
      const sessionId = 'sess-int-1';
      const { stdout } = await nodeExec(
        client,
        `curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST ` +
          `-d 'hello-from-node' http://127.0.0.1:${remotePort}/api/hooks/${sessionId}`,
      );

      expect(stdout.trim()).toBe('200');
      const hit = hookHits.find((h) => h.url === `/api/hooks/${sessionId}`);
      expect(hit).toBeDefined();
      expect(hit?.body).toContain('hello-from-node');
    } finally {
      await tunnel.dispose();
    }
  }, 30_000);

  it('binds to loopback only — not reachable on the node external interface (NFR-SEC4)', async () => {
    const tunnel = new ReverseTunnel(sshTunnelHost(client), {
      host: '127.0.0.1',
      port: hookPort,
    });
    const remotePort = await tunnel.start();
    try {
      // PRIMARY PROOF (works on any node, no extra tools): a connect to the
      // node's NON-loopback address on the forwarded port must NOT reach our
      // endpoint. ssh -R bound to 127.0.0.1 means sshd only listens on loopback,
      // so an external-interface connect is refused (curl http_code 000).
      const before = hookHits.length;
      const { stdout: ext } = await nodeExec(
        client,
        `IP=$(hostname -i 2>/dev/null | awk '{print $1}'); ` +
          `[ -z "$IP" ] && IP=$(hostname); ` +
          `curl -s -m 5 -o /dev/null -w '%{http_code}' ` +
          `http://$IP:${remotePort}/api/hooks/should-not-arrive 2>/dev/null || echo 000`,
      );
      // It must NOT be a successful 200, and our endpoint must not have been hit
      // via the external interface.
      expect(ext.trim()).not.toBe('200');
      expect(hookHits.length).toBe(before);

      // Sanity: loopback on the SAME port DOES reach us (so the negative result
      // above is genuinely about the interface, not a dead tunnel).
      const { stdout: loop } = await nodeExec(
        client,
        `curl -s -m 8 -o /dev/null -w '%{http_code}' ` +
          `http://127.0.0.1:${remotePort}/api/hooks/loopback-ok 2>/dev/null || echo 000`,
      );
      expect(loop.trim()).toBe('200');

      // SECONDARY PROOF (only when ss/netstat exist): every listener for the
      // forwarded port is loopback-bound (127.0.0.1 / [::1]), never a wildcard
      // (0.0.0.0 / * / [::]) — the latter would mean GatewayPorts exposed it.
      const { stdout: sockets } = await nodeExec(
        client,
        `(command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null) || ` +
          `(command -v netstat >/dev/null 2>&1 && netstat -ltn 2>/dev/null) || echo NO_TOOL`,
      );
      if (!sockets.includes('NO_TOOL')) {
        const rows = sockets.split('\n').filter((l) => l.includes(`:${remotePort}`));
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row).toMatch(/127\.0\.0\.1:|\[::1\]:/);
          expect(row).not.toMatch(/0\.0\.0\.0:|(^|\s)\*:|\[::\]:/);
        }
      }
    } finally {
      await tunnel.dispose();
    }
  }, 30_000);
});
