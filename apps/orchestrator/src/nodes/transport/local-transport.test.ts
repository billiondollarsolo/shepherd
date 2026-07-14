/**
 * LocalTransport — US-7 acceptance: "Same contract test suite green for
 * LocalTransport". The shared contract battery (transport-contract.ts) runs here
 * in-process (no SSH hop), exercising exec / openPty / dispose against the
 * orchestrator host. SshTransport (US-8) runs the SAME suite in its int test.
 *
 * These are unit-level (run under `pnpm test:unit`): LocalTransport needs only a
 * POSIX shell + node-pty, both present in the dev/CI image (Dockerfile.dev).
 */
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import { LocalTransport } from './local-transport.js';
import { runTransportContract } from './transport-contract.js';
import { TransportDisposedError, TransportInvalidCommandError } from './transport.js';

// The shared seam: same suite, run against the local impl.
runTransportContract('LocalTransport', () => new LocalTransport());

describe('LocalTransport — local-specific behaviour', () => {
  it('declares kind "local" (no SSH hop)', () => {
    const t = new LocalTransport();
    expect(t.kind).toBe('local');
    return t.dispose();
  });

  it('throws TransportInvalidCommandError for an empty exec command', async () => {
    const t = new LocalTransport();
    await expect(t.exec([])).rejects.toBeInstanceOf(TransportInvalidCommandError);
    await t.dispose();
  });

  it('throws TransportDisposedError after dispose', async () => {
    const t = new LocalTransport();
    await t.dispose();
    await expect(t.exec(['true'])).rejects.toBeInstanceOf(TransportDisposedError);
  });

  it('exec resolves stdout for a real binary on the host', async () => {
    const t = new LocalTransport();
    const result = await t.exec(['node', '-e', 'process.stdout.write("from-node")']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('from-node');
    await t.dispose();
  });

  it('exec rejects when the binary does not exist', async () => {
    const t = new LocalTransport();
    await expect(t.exec(['this-binary-should-not-exist-flock'])).rejects.toBeDefined();
    await t.dispose();
  });

  it('dials only the selected numeric loopback endpoint', async () => {
    const server = createServer((socket) => socket.end('ready'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const transport = new LocalTransport();
    try {
      const socket = await transport.dialTcp(port, '127.0.0.1');
      const body = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        socket.on('error', reject);
      });
      expect(body).toBe('ready');
    } finally {
      await transport.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
