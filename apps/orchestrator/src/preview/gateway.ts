import { randomBytes } from 'node:crypto';
import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import type { Duplex } from 'node:stream';
import type { PreviewRoutingTestResponse } from '@flock/shared';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import type { ActivePreview, PreviewService } from './service.js';

const BOOTSTRAP_PATH = '/_shepherd/authorize';
const ASK_PATH = '/_shepherd/caddy-ask';
const HEALTH_PATH = '/_shepherd/health';
const MAX_AUTH_BODY_BYTES = 2_048;
const MAX_HEADER_BYTES = 16 * 1024;
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface PreviewGateway {
  readonly server: Server;
  readonly servers: readonly Server[];
  listen(): Promise<void>;
  close(): Promise<void>;
}

function hostnameFromHost(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

function writePlain(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(message);
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Node's HTTP agent accepts a custom `createConnection`, but its implementation
 * treats the returned Duplex like a `net.Socket` and unconditionally calls the
 * socket timing/tuning methods. SSH and agentd tunnels are intentionally generic
 * Duplex streams, so adapt only that small socket surface here. Keeping the
 * adapter at the HTTP boundary also leaves raw WebSocket tunnels untouched.
 */
function asHttpClientSocket(stream: Duplex): Duplex {
  const socket = stream as Duplex & {
    setTimeout?: (timeout: number, callback?: () => void) => Duplex;
    setNoDelay?: (noDelay?: boolean) => Duplex;
    setKeepAlive?: (enable?: boolean, initialDelay?: number) => Duplex;
  };
  let timeoutMs = 0;
  let timer: NodeJS.Timeout | undefined;

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const armTimer = (): void => {
    clearTimer();
    if (timeoutMs <= 0 || stream.destroyed) return;
    timer = setTimeout(() => stream.emit('timeout'), timeoutMs);
    timer.unref?.();
  };

  if (typeof socket.setTimeout !== 'function') {
    socket.setTimeout = (timeout, callback) => {
      timeoutMs = Math.max(0, timeout);
      if (callback) stream.once('timeout', callback);
      armTimer();
      return stream;
    };
    // Match net.Socket's inactivity semantics closely enough for streaming
    // responses: incoming data and completed buffered writes renew the timer.
    stream.on('data', armTimer);
    stream.on('drain', armTimer);
    stream.once('close', clearTimer);
    stream.once('end', clearTimer);
  }
  if (typeof socket.setNoDelay !== 'function') socket.setNoDelay = () => stream;
  if (typeof socket.setKeepAlive !== 'function') socket.setKeepAlive = () => stream;
  return stream;
}

function isServiceWorkerRequest(headers: IncomingHttpHeaders): boolean {
  return headers['service-worker'] === 'script' || headers['sec-fetch-dest'] === 'serviceworker';
}

function hasExactPreviewOrigin(request: IncomingMessage, record: ActivePreview): boolean {
  const raw = request.headers.origin;
  if (Array.isArray(raw) || !raw) return false;
  return raw === new URL(record.origin).origin;
}

function isReservedCookie(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.startsWith('__host-shepherd_') || normalized.startsWith('shepherd_');
}

function applicationCookies(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const safe = raw
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const separator = part.indexOf('=');
      return separator > 0 && !isReservedCookie(part.slice(0, separator).trim());
    });
  return safe.length > 0 ? safe.join('; ') : undefined;
}

function safeSetCookies(raw: string[] | undefined): string[] | undefined {
  const safe = raw?.filter((value) => {
    const separator = value.indexOf('=');
    return separator > 0 && !isReservedCookie(value.slice(0, separator).trim());
  });
  return safe && safe.length > 0 ? safe : undefined;
}

function connectionNamedHeaders(headers: IncomingHttpHeaders): Set<string> {
  const names = new Set(HOP_BY_HOP);
  const raw = headers.connection;
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const value of values) {
    for (const name of value.split(',')) names.add(name.trim().toLowerCase());
  }
  return names;
}

function upstreamHeaders(
  headers: IncomingHttpHeaders,
  port: number,
  protocol: 'http' | 'https',
): OutgoingHttpHeaders {
  const clean: OutgoingHttpHeaders = {};
  const denied = new Set([
    'authorization',
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-port',
    'x-forwarded-proto',
    'x-real-ip',
    ...connectionNamedHeaders(headers),
  ]);
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !denied.has(name)) clean[name] = value;
  }
  const cookie = applicationCookies(
    Array.isArray(headers.cookie) ? headers.cookie.join('; ') : headers.cookie,
  );
  if (cookie) clean.cookie = cookie;
  else delete clean.cookie;
  clean.host = `127.0.0.1:${port}`;
  if (clean.origin) clean.origin = `${protocol}://127.0.0.1:${port}`;
  delete clean.referer;
  return clean;
}

function downstreamHeaders(
  headers: IncomingHttpHeaders,
  record: ActivePreview,
): OutgoingHttpHeaders {
  const clean: OutgoingHttpHeaders = { ...headers };
  for (const name of connectionNamedHeaders(headers)) delete clean[name];
  const setCookie = safeSetCookies(headers['set-cookie']);
  if (setCookie) clean['set-cookie'] = setCookie;
  else delete clean['set-cookie'];
  delete clean['clear-site-data'];
  const location = headers.location;
  if (location) {
    try {
      const parsed = new URL(location);
      const loopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname.toLowerCase());
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      if (loopback && port === String(record.port)) {
        clean.location = `${record.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
    } catch {
      // Relative Location values already resolve against the isolated preview origin.
    }
  }
  clean['cache-control'] ??= 'no-store';
  clean['cross-origin-opener-policy'] = 'same-origin';
  clean['permissions-policy'] =
    'camera=(), microphone=(), geolocation=(), payment=(), serial=(), usb=(), publickey-credentials-get=()';
  clean['referrer-policy'] = 'no-referrer';
  clean['service-worker-allowed'] = '/_shepherd/service-workers-disabled';
  clean['x-content-type-options'] = 'nosniff';
  return clean;
}

async function readJsonToken(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > MAX_AUTH_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { token?: unknown };
    return typeof value.token === 'string' ? value.token : null;
  } catch {
    return null;
  }
}

function renderBootstrap(response: ServerResponse): void {
  const nonce = randomBytes(18).toString('base64url');
  const script = `
    const params = new URLSearchParams(location.hash.slice(1));
    const token = params.get('token');
    history.replaceState(null, '', location.pathname);
    if (!token) document.body.textContent = 'This preview link is missing its capability.';
    else fetch('${BOOTSTRAP_PATH}', {
      method: 'POST', credentials: 'include',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({token})
    }).then((result) => {
      if (!result.ok) throw new Error('Preview authorization failed');
      location.replace('/');
    }).catch((error) => { document.body.textContent = error.message; });
  `;
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Opening preview…</title></head><body>Opening secure preview…<script nonce="${nonce}">${script}</script></body></html>`;
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; connect-src 'self'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    'cross-origin-opener-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function cookieToken(
  service: PreviewService,
  record: ActivePreview,
  request: IncomingMessage,
): string | null {
  const cookieName = service.cookieName(record);
  const occurrences = (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim().split('=', 1)[0])
    .filter((name) => name === cookieName).length;
  if (occurrences !== 1) return null;
  const cookies = parseCookie(request.headers.cookie ?? '');
  return cookies[cookieName] ?? null;
}

async function proxyHttp(
  service: PreviewService,
  record: ActivePreview,
  request: IncomingMessage,
  response: ServerResponse,
  connections: PreviewConnections,
): Promise<void> {
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > service.limits().maxRequestBytes) {
    request.resume();
    return writePlain(response, 413, 'Preview request exceeded the configured limit.');
  }
  const releaseReservation = connections.reserve(
    record.id,
    service.limits().maxConnectionsPerPreview,
  );
  if (!releaseReservation) {
    request.resume();
    return writePlain(response, 429, 'Too many connections to this preview.');
  }
  let stream: Duplex;
  try {
    stream = await service.dial(record);
  } catch (error) {
    releaseReservation();
    return writePlain(response, 502, `Preview upstream unavailable: ${(error as Error).message}`);
  }
  releaseReservation();
  connections.track(record.id, stream);
  if (request.destroyed || response.destroyed) {
    stream.destroy();
    return;
  }
  const agent =
    record.protocol === 'https'
      ? new HttpsAgent({
          keepAlive: false,
          rejectUnauthorized: true,
        })
      : new Agent({ keepAlive: false });
  Object.assign(agent, {
    createConnection: () =>
      record.protocol === 'https'
        ? tlsConnect({ socket: stream, servername: 'localhost', rejectUnauthorized: true })
        : asHttpClientSocket(stream),
  });
  const requestUpstream = record.protocol === 'https' ? httpsRequest : httpRequest;
  const upstream = requestUpstream({
    method: request.method,
    path: request.url,
    headers: upstreamHeaders(request.headers, record.port, record.protocol),
    agent,
  });
  upstream.setTimeout(service.limits().upstreamTimeoutMs, () =>
    upstream.destroy(new Error('preview upstream timed out')),
  );
  upstream.on('response', (upstreamResponse) => {
    service.noteEmbeddingHeaders(record, upstreamResponse.headers);
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      downstreamHeaders(upstreamResponse.headers, record),
    );
    let bytes = 0;
    upstreamResponse.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > service.limits().maxResponseBytes) {
        upstreamResponse.destroy(new Error('preview response exceeded the configured limit'));
        response.destroy();
      }
    });
    upstreamResponse.pipe(response);
    upstreamResponse.on('close', () => agent.destroy());
  });
  upstream.on('error', (error) => {
    agent.destroy();
    if (!response.headersSent)
      writePlain(response, 502, `Preview upstream unavailable: ${error.message}`);
    else response.destroy(error);
  });
  request.on('aborted', () => upstream.destroy());
  let requestBytes = 0;
  let requestRejected = false;
  request.on('data', (chunk: Buffer | string) => {
    requestBytes += Buffer.byteLength(chunk);
    if (!requestRejected && requestBytes > service.limits().maxRequestBytes) {
      requestRejected = true;
      request.unpipe(upstream);
      upstream.destroy(new Error('preview request exceeded the configured limit'));
      if (!response.headersSent)
        writePlain(response, 413, 'Preview request exceeded the configured limit.');
      request.resume();
    }
  });
  request.pipe(upstream);
}

async function proxyUpgrade(
  service: PreviewService,
  record: ActivePreview,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  connections: PreviewConnections,
): Promise<void> {
  const releaseReservation = connections.reserve(
    record.id,
    service.limits().maxConnectionsPerPreview,
  );
  if (!releaseReservation) {
    rejectUpgrade(socket, 429, 'Too Many Requests');
    return;
  }
  let upstream: Duplex;
  try {
    upstream = await service.dial(record);
    if (record.protocol === 'https') upstream = await secureUpstream(upstream);
  } catch {
    releaseReservation();
    rejectUpgrade(socket, 502, 'Bad Gateway');
    return;
  }
  releaseReservation();
  connections.track(record.id, upstream);
  connections.track(record.id, socket, false);
  const headers = upstreamHeaders(request.headers, record.port, record.protocol);
  headers.connection = 'Upgrade';
  headers.upgrade = request.headers.upgrade ?? 'websocket';
  const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
  }
  upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
  if (head.length > 0) upstream.write(head);
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.pipe(upstream).pipe(socket);
}

function secureUpstream(stream: Duplex): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({
      socket: stream,
      servername: 'localhost',
      rejectUnauthorized: true,
    });
    const onError = (error: Error): void => {
      secure.destroy();
      reject(error);
    };
    secure.once('error', onError);
    secure.once('secureConnect', () => {
      secure.off('error', onError);
      resolve(secure);
    });
  });
}

class PreviewConnections {
  private readonly active = new Map<string, Set<Duplex>>();
  private readonly activeCounts = new Map<string, number>();
  private readonly pending = new Map<string, number>();

  reserve(hostname: string, limit: number): (() => void) | null {
    const count = (this.activeCounts.get(hostname) ?? 0) + (this.pending.get(hostname) ?? 0);
    if (count >= limit) return null;
    this.pending.set(hostname, (this.pending.get(hostname) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.pending.get(hostname) ?? 1) - 1;
      if (remaining > 0) this.pending.set(hostname, remaining);
      else this.pending.delete(hostname);
    };
  }

  track(hostname: string, stream: Duplex, countTowardLimit = true): void {
    const streams = this.active.get(hostname) ?? new Set<Duplex>();
    streams.add(stream);
    this.active.set(hostname, streams);
    if (countTowardLimit) {
      this.activeCounts.set(hostname, (this.activeCounts.get(hostname) ?? 0) + 1);
    }
    const forget = (): void => {
      streams.delete(stream);
      if (countTowardLimit) {
        const remaining = (this.activeCounts.get(hostname) ?? 1) - 1;
        if (remaining > 0) this.activeCounts.set(hostname, remaining);
        else this.activeCounts.delete(hostname);
      }
      if (streams.size === 0) {
        this.active.delete(hostname);
        this.activeCounts.delete(hostname);
      }
    };
    stream.once('close', forget);
  }

  close(hostname: string): void {
    this.pending.delete(hostname);
    const streams = this.active.get(hostname);
    if (!streams) return;
    this.active.delete(hostname);
    this.activeCounts.delete(hostname);
    for (const stream of streams) stream.destroy();
  }

  closeAll(): void {
    for (const hostname of [...this.active.keys()]) this.close(hostname);
    this.activeCounts.clear();
    this.pending.clear();
  }
}

export function createPreviewGateway(
  service: PreviewService,
  options: {
    host: string;
    port: number;
    pool?: { host: string; ports: readonly number[] } | null;
  },
): PreviewGateway {
  const connections = new PreviewConnections();
  const unsubscribe = service.onInactive((recordId) => connections.close(recordId));

  const makeServer = (acceptedPublicPort: number | null): Server => {
    const poolListener = acceptedPublicPort !== null;
    const resolveRecord = (request: IncomingMessage): ActivePreview | null => {
      const hostname = hostnameFromHost(request.headers.host);
      if (!hostname) return null;
      if (poolListener) {
        const record = service.recordForPublicPort(acceptedPublicPort);
        return record?.hostname === hostname ? record : null;
      }
      return service.recordForHostname(hostname);
    };
    const instance = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://preview.invalid');
        if (!poolListener && url.pathname === HEALTH_PATH && request.method === 'GET') {
          return writePlain(response, 200, 'ok');
        }
        if (!poolListener && url.pathname === ASK_PATH) {
          if (request.method !== 'GET') return writePlain(response, 405, 'Method not allowed.');
          const domain = url.searchParams.get('domain')?.toLowerCase() ?? '';
          return writePlain(response, service.isActiveHostname(domain) ? 200 : 404, '');
        }
        if (
          !request.url?.startsWith('/') ||
          request.method === 'CONNECT' ||
          request.method === 'TRACE'
        ) {
          request.resume();
          return writePlain(response, 405, 'Unsupported Preview request.');
        }
        const record = resolveRecord(request);
        if (!record) return writePlain(response, 404, 'Preview not found or expired.');
        if (UNSAFE_METHODS.has(request.method ?? '') && !hasExactPreviewOrigin(request, record)) {
          request.resume();
          return writePlain(response, 403, 'Preview request Origin was rejected.');
        }
        if (url.pathname === BOOTSTRAP_PATH && request.method === 'GET') {
          return renderBootstrap(response);
        }
        if (url.pathname === BOOTSTRAP_PATH && request.method === 'POST') {
          if (
            !String(request.headers['content-type'] ?? '')
              .toLowerCase()
              .startsWith('application/json')
          ) {
            request.resume();
            return writePlain(response, 415, 'Preview authorization requires JSON.');
          }
          const token = await readJsonToken(request);
          if (!token || !service.authorize(record, token)) {
            return writePlain(response, 401, 'Preview authorization failed.');
          }
          const cookieName = service.cookieName(record);
          response.writeHead(204, {
            'set-cookie': serializeCookie(cookieName, token, {
              path: '/',
              httpOnly: true,
              secure: cookieName.startsWith('__Host-'),
              sameSite: 'strict',
              maxAge: service.cookieMaxAge(record),
            }),
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          });
          return response.end();
        }
        if (isServiceWorkerRequest(request.headers)) {
          return writePlain(response, 403, 'Service workers are disabled in Preview.');
        }
        const token = cookieToken(service, record, request);
        if (!token || !service.authenticate(record, token)) {
          return writePlain(response, 401, 'Open this Preview from Shepherd to authorize it.');
        }
        await proxyHttp(service, record, request, response, connections);
      })().catch((error) => {
        if (!response.headersSent) writePlain(response, 500, 'Preview gateway error.');
        else response.destroy(error as Error);
      });
    });
    instance.headersTimeout = 15_000;
    instance.requestTimeout = service.limits().upstreamTimeoutMs;
    instance.keepAliveTimeout = 5_000;
    instance.maxHeadersCount = 100;
    instance.maxRequestsPerSocket = 100;
    instance.on('upgrade', (request, socket, head) => {
      const record = resolveRecord(request);
      if (
        !record ||
        request.method !== 'GET' ||
        request.headers.upgrade?.toLowerCase() !== 'websocket' ||
        !hasExactPreviewOrigin(request, record) ||
        isServiceWorkerRequest(request.headers)
      ) {
        return rejectUpgrade(socket, 403, 'Forbidden');
      }
      const token = cookieToken(service, record, request);
      if (!token || !service.authenticate(record, token)) {
        return rejectUpgrade(socket, 401, 'Unauthorized');
      }
      void proxyUpgrade(service, record, request, socket, head, connections);
    });
    return instance;
  };

  const poolPorts = options.pool?.ports ?? [];
  const servers =
    poolPorts.length > 0 ? poolPorts.map((port) => makeServer(port)) : [makeServer(null)];
  const bindings =
    poolPorts.length > 0
      ? poolPorts.map((port) => ({ port, host: options.pool!.host }))
      : [{ port: options.port, host: options.host }];
  const server = servers[0]!;

  const routingTest = async (): Promise<PreviewRoutingTestResponse['checks']> => {
    if (!servers.every((instance) => instance.listening)) {
      return [
        {
          id: 'gateway',
          status: 'fail',
          detail: 'One or more Preview listeners are not accepting connections.',
        },
      ];
    }
    if (poolPorts.length === 0) {
      const address = server.address();
      if (!address || typeof address === 'string') {
        return [
          { id: 'gateway', status: 'fail', detail: 'The hostname gateway has no TCP listener.' },
        ];
      }
      const status = await internalStatus(
        loopbackFor(address.address),
        address.port,
        HEALTH_PATH,
        'preview.invalid',
      );
      return [
        {
          id: 'gateway',
          status: status === 200 ? 'pass' : 'fail',
          detail:
            status === 200
              ? 'The dedicated hostname gateway health route responded successfully.'
              : `The hostname gateway returned HTTP ${status}.`,
        },
      ];
    }
    const statuses = await Promise.all(
      servers.map((instance) => {
        const address = instance.address();
        if (!address || typeof address === 'string') return Promise.resolve(0);
        return internalStatus(
          loopbackFor(address.address),
          address.port,
          '/',
          'unallocated.invalid',
        );
      }),
    );
    const isolated = statuses.every((status) => status === 404);
    return [
      {
        id: 'gateway',
        status: isolated ? 'pass' : 'fail',
        detail: isolated
          ? `All ${statuses.length} Preview-only pool listeners are bound and reject unallocated routes.`
          : 'A pool listener is unavailable or served content without an active allocation.',
      },
    ];
  };
  service.setRoutingTester(routingTest);

  const listenOne = (instance: Server, binding: { port: number; host: string }) =>
    new Promise<void>((resolve, reject) => {
      instance.once('error', reject);
      instance.listen(binding.port, binding.host, () => {
        instance.off('error', reject);
        resolve();
      });
    });

  const closeOne = (instance: Server) =>
    new Promise<void>((resolve, reject) => {
      if (!instance.listening) return resolve();
      instance.close((error) => (error ? reject(error) : resolve()));
      instance.closeAllConnections?.();
    });

  return {
    server,
    servers,
    listen: async () => {
      try {
        for (let index = 0; index < servers.length; index += 1) {
          await listenOne(servers[index]!, bindings[index]!);
        }
        service.setGatewayHealthy(true);
      } catch (error) {
        service.setGatewayHealthy(false);
        await Promise.allSettled(servers.map(closeOne));
        throw error;
      }
    },
    close: async () => {
      unsubscribe();
      service.setRoutingTester(null);
      connections.closeAll();
      service.setGatewayHealthy(false);
      const results = await Promise.allSettled(servers.map(closeOne));
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failed) throw failed.reason;
    },
  };
}

function loopbackFor(address: string): string {
  return address.includes(':') ? '::1' : '127.0.0.1';
}

function internalStatus(
  hostname: string,
  port: number,
  path: string,
  host: string,
): Promise<number> {
  return new Promise((resolve) => {
    const request = httpRequest(
      { hostname, port, path, method: 'GET', headers: { host }, timeout: 2_000 },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.once('timeout', () => request.destroy());
    request.once('error', () => resolve(0));
    request.end();
  });
}
