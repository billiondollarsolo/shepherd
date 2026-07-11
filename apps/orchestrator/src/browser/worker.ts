import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import Docker from 'dockerode';
import { z } from 'zod';
import { LayerABrowserManager, type DockerLike, type SessionBrowser } from './layerA/index.js';

const SessionId = z.string().uuid();

export interface BrowserWorkerLifecycle {
  launch(sessionId: string): Promise<SessionBrowser>;
  stop(sessionId: string): Promise<boolean>;
  reap(): Promise<string[]>;
  stopAll(): Promise<void>;
}

function equalToken(actual: string | undefined, expected: string): boolean {
  const prefix = 'Bearer ';
  if (!actual?.startsWith(prefix)) return false;
  const left = createHash('sha256').update(actual.slice(prefix.length)).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

export function buildBrowserWorker(
  lifecycle: BrowserWorkerLifecycle,
  token: string,
): FastifyInstance {
  if (token.length < 32) throw new Error('browser worker token must be at least 32 bytes');
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : true,
    bodyLimit: 8 * 1024,
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    if (!equalToken(request.headers.authorization, token)) {
      await reply.code(401).send({ error: { code: 'unauthorized', message: 'Unauthorized' } });
    }
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.post('/v1/browsers', async (request, reply) => {
    const parsed = z.object({ sessionId: SessionId }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request' } });
    return lifecycle.launch(parsed.data.sessionId);
  });
  app.delete('/v1/browsers/:sessionId', async (request, reply) => {
    const parsed = SessionId.safeParse((request.params as { sessionId?: string }).sessionId);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request' } });
    return { stopped: await lifecycle.stop(parsed.data) };
  });
  app.post('/v1/reap', async () => ({ removed: await lifecycle.reap() }));
  app.post('/v1/stop-all', async (_request, reply) => {
    await lifecycle.stopAll();
    return reply.code(204).send();
  });
  return app;
}

async function resolveNetworkCdp(params: {
  bindHost: string;
  containerCdpPort: number;
}): Promise<{ hostPort: number; host?: string; browserWsPath?: string }> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const { address } = await lookup(params.bindHost, { family: 4 });
      const response = await fetch(`http://${address}:${params.containerCdpPort}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) throw new Error(`CDP discovery returned ${response.status}`);
      const body = (await response.json()) as { webSocketDebuggerUrl?: string };
      const path = body.webSocketDebuggerUrl
        ? new URL(body.webSocketDebuggerUrl).pathname
        : undefined;
      return { host: address, hostPort: params.containerCdpPort, browserWsPath: path };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('CDP discovery timed out');
}

export async function main(): Promise<void> {
  const tokenFile = process.env.BROWSER_WORKER_TOKEN_FILE;
  if (!tokenFile) throw new Error('BROWSER_WORKER_TOKEN_FILE is required');
  const token = readFileSync(tokenFile, 'utf8').trim();
  const docker = new Docker({
    socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
  }) as unknown as DockerLike;
  const lifecycle = new LayerABrowserManager({
    docker,
    resolveCdp: resolveNetworkCdp,
    config: {
      image: process.env.BROWSER_IMAGE ?? 'flock/session-chrome:latest',
      networkName: process.env.BROWSER_NETWORK ?? 'flock_internal',
      maxConcurrent: Number(process.env.BROWSER_MAX_CONCURRENT ?? 4),
      memoryBytes: Number(process.env.BROWSER_MEMORY_BYTES ?? 1024 * 1024 * 1024),
      nanoCpus: Number(process.env.BROWSER_NANO_CPUS ?? 1_000_000_000),
      pidsLimit: Number(process.env.BROWSER_PIDS_LIMIT ?? 512),
    },
  });
  const app = buildBrowserWorker(lifecycle, token);
  await app.listen({ host: '0.0.0.0', port: Number(process.env.BROWSER_WORKER_PORT ?? 8090) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[flock-browser-worker] failed to start', error);
    process.exit(1);
  });
}
