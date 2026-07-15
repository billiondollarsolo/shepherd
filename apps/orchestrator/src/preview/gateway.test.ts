import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createConnection } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { Database } from '../db/client.js';
import { previewRuntimeSettings } from '../db/schema.js';
import type { NodeTransport } from '../nodes/transport/transport.js';
import { AuditLogger } from '../audit/audit.js';
import { createPreviewGateway, type PreviewGateway } from './gateway.js';
import { PreviewService, type ActivePreview } from './service.js';

const SERVICE_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const NODE_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';

interface Response {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function genericTcpTunnel(port: number): Duplex {
  const upstream = createConnection({ host: '127.0.0.1', port });
  const tunnel = new Duplex({
    read() {
      upstream.resume();
    },
    write(chunk, encoding, callback) {
      upstream.write(chunk, encoding, callback);
    },
    final(callback) {
      upstream.end(callback);
    },
    destroy(_error, callback) {
      upstream.destroy();
      callback(null);
    },
  });
  upstream.pause();
  upstream.on('data', (chunk) => {
    if (!tunnel.push(chunk)) upstream.pause();
  });
  upstream.on('end', () => tunnel.push(null));
  upstream.on('error', (error) => tunnel.destroy(error));
  upstream.on('close', () => tunnel.destroy());
  return tunnel;
}

function request(
  port: number,
  path: string,
  options: { method?: string; host?: string; headers?: IncomingHttpHeaders; body?: string } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { host: options.host ?? 'p-fixed.preview.localhost', ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body) req.end(options.body);
    else req.end();
  });
}

describe('Remote Preview gateway', () => {
  let gateway: PreviewGateway | undefined;
  let upstream: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (gateway) await gateway.close();
    if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    gateway = undefined;
    upstream = undefined;
  });

  it('exchanges the fragment capability, strips credentials, proxies HTTP/WS, and blocks service workers', async () => {
    let receivedUrl: string | undefined;
    let receivedHeaders: IncomingHttpHeaders | undefined;
    upstream = createServer((req, res) => {
      receivedUrl = req.url;
      receivedHeaders = req.headers;
      res.setHeader('set-cookie', [
        'upstream_session=allowed; Path=/; HttpOnly',
        '__Host-shepherd_preview=must-not-escape; Path=/; Secure',
      ]);
      res.setHeader('clear-site-data', '"cookies"');
      res.end('ok');
    });
    const websocketServer = new WebSocketServer({ noServer: true });
    upstream.on('upgrade', (req, socket, head) => {
      websocketServer.handleUpgrade(req, socket, head, (client) => {
        client.on('message', (message) => client.send(`echo:${message.toString()}`));
      });
    });
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const db = {
      select: () => ({
        from: (table: unknown) =>
          table === previewRuntimeSettings
            ? { where: () => ({ limit: async () => [] }) }
            : {
                innerJoin: () => ({
                  innerJoin: () => ({
                    where: () => ({
                      limit: async () => [
                        {
                          id: SERVICE_ID,
                          projectId: PROJECT_ID,
                          nodeId: NODE_ID,
                          owner: OWNER_ID,
                          targetHost: '127.0.0.1',
                          port: upstreamPort,
                          protocol: 'http',
                        },
                      ],
                    }),
                  }),
                }),
              },
      }),
    } as unknown as Database;
    const transport = {
      kind: 'local',
      exec: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }),
      openPty: async () => {
        throw new Error('unused');
      },
      dispose: async () => undefined,
      // Model the real SSH/agentd path: it returns a generic Duplex rather than
      // a net.Socket, so it has no setTimeout/setNoDelay/setKeepAlive methods.
      dialTcp: async (port: number) => genericTcpTunnel(port),
    } as NodeTransport;
    const service = new PreviewService({
      db,
      audit: new AuditLogger({ write: async () => undefined }),
      config: {
        backend: 'hostname',
        deploymentMode: 'development',
        enabled: true,
        reason: null,
        publicBaseUrl: 'http://localhost',
        publicHost: 'localhost',
        domain: 'preview.localhost',
        portRange: null,
        scheme: 'http',
        publicPort: '',
        listenHost: '127.0.0.1',
        listenPort: 0,
        poolListenHost: '127.0.0.1',
        ttlMs: 60_000,
        maxConcurrent: 4,
        maxConnectionsPerPreview: 32,
        connectTimeoutMs: 500,
        upstreamTimeoutMs: 1_000,
        maxRequestBytes: 1024,
        maxResponseBytes: 1024 * 1024,
        secureCookies: false,
        privateModeWarning: null,
        embeddingEnabled: true,
        embeddingReason: null,
        frameSources: ['http://*.preview.localhost'],
      },
      transportForNode: () => transport,
      randomToken: () => 'preview-secret-token',
      randomSlug: () => 'fixed',
    });
    const created = await service.start(SERVICE_ID, undefined, { userId: OWNER_ID });
    const host = new URL(created.forward.origin).hostname;

    gateway = createPreviewGateway(service, { host: '127.0.0.1', port: 0 });
    await gateway.listen();
    const gatewayPort = (gateway.server.address() as AddressInfo).port;

    const bootstrap = await request(gatewayPort, '/_shepherd/authorize', { host });
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers['content-security-policy']).toContain("default-src 'none'");
    expect(bootstrap.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(bootstrap.body).not.toContain('preview-secret-token');

    const authorized = await request(gatewayPort, '/_shepherd/authorize', {
      host,
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: created.forward.origin },
      body: JSON.stringify({ token: 'preview-secret-token' }),
    });
    expect(authorized.status).toBe(204);
    const cookie = authorized.headers['set-cookie']![0]!.split(';', 1)[0]!;
    expect(cookie).toContain('shepherd_preview_');
    expect(authorized.headers['set-cookie']![0]).toContain('HttpOnly');
    const replayed = await request(gatewayPort, '/_shepherd/authorize', {
      host,
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: created.forward.origin },
      body: JSON.stringify({ token: 'preview-secret-token' }),
    });
    expect(replayed.status).toBe(401);

    const duplicateCookie = await request(gatewayPort, '/', {
      host,
      headers: { cookie: `${cookie}; ${cookie}` },
    });
    expect(duplicateCookie.status).toBe(401);

    const proxied = await request(gatewayPort, '/hello?x=1', {
      host,
      headers: {
        cookie: `${cookie}; __Host-shepherd_session=must-not-cross; upstream_session=allowed`,
        authorization: 'Bearer must-not-cross',
        'x-forwarded-for': '203.0.113.9',
      },
    });
    expect(proxied.status, proxied.body).toBe(200);
    expect(proxied.headers['set-cookie']).toEqual(['upstream_session=allowed; Path=/; HttpOnly']);
    expect(proxied.headers['clear-site-data']).toBeUndefined();
    expect(proxied.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(receivedUrl).toBe('/hello?x=1');
    expect(receivedHeaders?.cookie).toBe('upstream_session=allowed');
    expect(receivedHeaders?.authorization).toBeUndefined();
    expect(receivedHeaders?.['x-forwarded-for']).toBeUndefined();
    expect(receivedHeaders?.host).toBe(`127.0.0.1:${upstreamPort}`);

    const oversized = await request(gatewayPort, '/upload', {
      host,
      method: 'POST',
      headers: { cookie, origin: created.forward.origin },
      body: 'x'.repeat(1025),
    });
    expect(oversized.status).toBe(413);

    const worker = await request(gatewayPort, '/sw.js', {
      host,
      headers: { cookie, 'service-worker': 'script' },
    });
    expect(worker.status).toBe(403);

    const ask = await request(
      gatewayPort,
      `/_shepherd/caddy-ask?domain=${encodeURIComponent(host)}`,
    );
    expect(ask.status).toBe(200);

    const message = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/hmr`, {
        headers: { host, cookie, origin: created.forward.origin },
      });
      ws.on('open', () => ws.send('ping'));
      ws.on('message', (data) => {
        resolve(data.toString());
        ws.close();
      });
      ws.on('error', reject);
    });
    expect(message).toBe('echo:ping');

    const persistent = new WebSocket(`ws://127.0.0.1:${gatewayPort}/hmr`, {
      headers: { host, cookie, origin: created.forward.origin },
    });
    await new Promise<void>((resolve, reject) => {
      persistent.once('open', resolve);
      persistent.once('error', reject);
    });
    const closed = new Promise<void>((resolve) => persistent.once('close', () => resolve()));
    await service.revoke(SERVICE_ID, { userId: OWNER_ID });
    await closed;
    const revokedAsk = await request(
      gatewayPort,
      `/_shepherd/caddy-ask?domain=${encodeURIComponent(host)}`,
    );
    expect(revokedAsk.status).toBe(404);
  });

  it('keeps every private pool listener Preview-only and ignores spoofed routing headers', async () => {
    const reservations = [createServer(), createServer()];
    for (const reservation of reservations) {
      await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    }
    const ports = reservations.map((reservation) => (reservation.address() as AddressInfo).port);
    await Promise.all(
      reservations.map(
        (reservation) => new Promise<void>((resolve) => reservation.close(() => resolve())),
      ),
    );
    let tester: (() => Promise<unknown>) | null = null;
    const fakeService = {
      onInactive: () => () => undefined,
      setGatewayHealthy: vi.fn(),
      setRoutingTester: (value: (() => Promise<unknown>) | null) => {
        tester = value;
      },
      limits: () => ({
        maxConnectionsPerPreview: 1,
        maxRequestBytes: 1024,
        maxResponseBytes: 1024,
        connectTimeoutMs: 100,
        upstreamTimeoutMs: 1000,
      }),
      recordForPublicPort: () => null,
      recordForHostname: () => null,
      isActiveHostname: () => false,
    };
    gateway = createPreviewGateway(fakeService as unknown as PreviewService, {
      host: '127.0.0.1',
      port: 0,
      pool: { host: '127.0.0.1', ports },
    });
    await gateway.listen();

    for (const port of ports) {
      const response = await request(port, '/health', {
        host: '100.64.0.1',
        headers: { 'x-forwarded-port': String(ports.find((candidate) => candidate !== port)) },
      });
      expect(response.status).toBe(404);
    }
    expect(tester).not.toBeNull();
    await expect(tester!()).resolves.toEqual([
      expect.objectContaining({ id: 'gateway', status: 'pass' }),
    ]);
  });

  it('omits ineffective COOP from private non-loopback HTTP previews', async () => {
    upstream = createServer((_req, res) => {
      // A development server may emit this itself. The gateway must strip it
      // because the public private-HTTP origin is not a trustworthy context.
      res.setHeader('cross-origin-opener-policy', 'same-origin');
      res.end('private preview');
    });
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const publicPort = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));

    const record: ActivePreview = {
      id: SERVICE_ID,
      serviceId: SERVICE_ID,
      projectId: PROJECT_ID,
      nodeId: NODE_ID,
      targetHost: '127.0.0.1',
      port: upstreamPort,
      protocol: 'http',
      backend: 'port-pool',
      hostname: '100.64.0.1',
      publicPort,
      origin: `http://100.64.0.1:${publicPort}`,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      tokenHash: Buffer.alloc(32),
      launchAvailable: true,
      cookieName: 'shepherd_preview_private',
      embedding: 'unknown',
      embeddingReason: null,
    };
    const fakeService = {
      onInactive: () => () => undefined,
      setGatewayHealthy: vi.fn(),
      setRoutingTester: vi.fn(),
      limits: () => ({
        maxConnectionsPerPreview: 4,
        maxRequestBytes: 1024,
        maxResponseBytes: 1024,
        connectTimeoutMs: 100,
        upstreamTimeoutMs: 1000,
      }),
      recordForPublicPort: () => record,
      recordForHostname: () => null,
      isActiveHostname: () => false,
      authorize: () => true,
      authenticate: () => true,
      cookieName: () => record.cookieName,
      cookieMaxAge: () => 60,
      dial: () => Promise.resolve(genericTcpTunnel(upstreamPort)),
      noteEmbeddingHeaders: vi.fn(),
    };
    gateway = createPreviewGateway(fakeService as unknown as PreviewService, {
      host: '127.0.0.1',
      port: 0,
      pool: { host: '127.0.0.1', ports: [publicPort] },
    });
    await gateway.listen();
    const host = `100.64.0.1:${publicPort}`;

    const bootstrap = await request(publicPort, '/_shepherd/authorize', { host });
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers['cross-origin-opener-policy']).toBeUndefined();

    const authorized = await request(publicPort, '/_shepherd/authorize', {
      host,
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: record.origin },
      body: JSON.stringify({ token: 'private-preview-token' }),
    });
    expect(authorized.status).toBe(204);
    const cookie = authorized.headers['set-cookie']![0]!.split(';', 1)[0]!;
    const proxied = await request(publicPort, '/', { host, headers: { cookie } });
    expect(proxied.status).toBe(200);
    expect(proxied.body).toBe('private preview');
    expect(proxied.headers['cross-origin-opener-policy']).toBeUndefined();
  });
});
