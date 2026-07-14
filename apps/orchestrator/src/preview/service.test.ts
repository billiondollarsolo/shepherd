import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/client.js';
import { previewRuntimeSettings } from '../db/schema.js';
import type { NodeTransport } from '../nodes/transport/transport.js';
import { AuditLogger, type AuditEntry } from '../audit/audit.js';
import type { PreviewConfig } from './config.js';
import {
  PreviewForbiddenError,
  PreviewLimitError,
  PreviewService,
  PreviewUnavailableError,
} from './service.js';

const SERVICE_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const NODE_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';

function fakeDb(owner: string | null = OWNER_ID): Database {
  return {
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
                        owner,
                        targetHost: '127.0.0.1',
                        port: 3000,
                        protocol: 'http',
                      },
                    ],
                  }),
                }),
              }),
            },
    }),
  } as unknown as Database;
}

function config(overrides: Partial<PreviewConfig> = {}): PreviewConfig {
  return {
    backend: 'hostname',
    deploymentMode: 'development',
    enabled: true,
    reason: null,
    publicBaseUrl: 'http://localhost:11010',
    publicHost: 'localhost',
    domain: 'preview.localhost',
    portRange: null,
    scheme: 'http',
    publicPort: '11012',
    listenHost: '127.0.0.1',
    listenPort: 0,
    poolListenHost: '127.0.0.1',
    ttlMs: 60_000,
    maxConcurrent: 4,
    maxConnectionsPerPreview: 32,
    connectTimeoutMs: 100,
    upstreamTimeoutMs: 1_000,
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 1024 * 1024,
    secureCookies: false,
    privateModeWarning: null,
    embeddingEnabled: true,
    embeddingReason: null,
    frameSources: ['http://*.preview.localhost:11012'],
    ...overrides,
  };
}

function transport(dialTcp = vi.fn(async () => new PassThrough())): NodeTransport {
  return {
    kind: 'local',
    exec: vi.fn(),
    openPty: vi.fn(),
    dispose: vi.fn(),
    dialTcp,
  } as unknown as NodeTransport;
}

function harness(
  options: {
    owner?: string | null;
    config?: Partial<PreviewConfig>;
    transport?: NodeTransport | null;
    now?: () => number;
    randomToken?: () => string;
  } = {},
) {
  const audit: AuditEntry[] = [];
  const service = new PreviewService({
    db: fakeDb(options.owner),
    audit: new AuditLogger({ write: async (entry) => void audit.push(entry) }),
    config: config(options.config),
    transportForNode: () => (options.transport === undefined ? transport() : options.transport),
    now: options.now,
    randomToken: options.randomToken ?? (() => 'correct-horse-battery-staple-preview-token'),
    randomSlug: () => '0123456789abcdef0123',
  });
  return { service, audit };
}

describe('PreviewService', () => {
  it('issues only browser-safe metadata plus a fragment capability', async () => {
    const { service, audit } = harness();
    const created = await service.start(SERVICE_ID, undefined, {
      userId: OWNER_ID,
      ip: '127.0.0.1',
    });

    expect(created.forward).toMatchObject({
      backend: 'hostname',
      origin: 'http://p-0123456789abcdef0123.preview.localhost:11012',
    });
    expect(created.launchUrl).toContain('/_shepherd/authorize#token=');
    expect(JSON.stringify(created.forward)).not.toContain('token');
    const record = service.recordForHostname('p-0123456789abcdef0123.preview.localhost')!;
    expect(service.authorize(record, 'wrong')).toBeNull();
    expect(service.authorize(record, 'correct-horse-battery-staple-preview-token')).not.toBeNull();
    expect(audit).toContainEqual(expect.objectContaining({ action: 'preview_forward_start' }));
  });

  it('enforces project service ownership on start and revoke', async () => {
    const { service } = harness();
    await expect(
      service.start(SERVICE_ID, undefined, {
        userId: '55555555-5555-4555-8555-555555555555',
      }),
    ).rejects.toBeInstanceOf(PreviewForbiddenError);
    await expect(
      service.revoke(SERVICE_ID, {
        userId: '55555555-5555-4555-8555-555555555555',
      }),
    ).rejects.toBeInstanceOf(PreviewForbiddenError);
  });

  it('probes the requested node port and reports unavailable transports', async () => {
    const noDialer = {
      kind: 'local',
      exec: vi.fn(),
      openPty: vi.fn(),
      dispose: vi.fn(),
    } as unknown as NodeTransport;
    const { service } = harness({ transport: noDialer });
    await expect(service.start(SERVICE_ID, undefined, { userId: OWNER_ID })).rejects.toBeInstanceOf(
      PreviewUnavailableError,
    );
    expect(service.inactiveStatus(SERVICE_ID)).toBe('unreachable');
  });

  it('expires records and enforces the configured concurrency cap', async () => {
    let now = 1_000;
    const { service } = harness({ now: () => now, config: { ttlMs: 100, maxConcurrent: 1 } });
    await service.start(SERVICE_ID, undefined, { userId: OWNER_ID });
    await expect(
      service.start('66666666-6666-4666-8666-666666666666', undefined, { userId: OWNER_ID }),
    ).rejects.toBeInstanceOf(PreviewLimitError);
    now += 101;
    expect(service.size()).toBe(0);
    expect(service.inactiveStatus(SERVICE_ID)).toBe('expired');
  });

  it('expires an idle preview without waiting for another request', async () => {
    vi.useFakeTimers();
    try {
      const { service } = harness({ config: { ttlMs: 100 } });
      const inactive = vi.fn();
      service.onInactive(inactive);
      const { forward } = await service.start(SERVICE_ID, undefined, { userId: OWNER_ID });

      await vi.advanceTimersByTimeAsync(101);

      expect(service.activeForService(SERVICE_ID)).toBeNull();
      expect(inactive).toHaveBeenCalledOnce();
      expect(inactive).toHaveBeenCalledWith(forward.id);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('revokes access immediately and audits the lifecycle', async () => {
    const { service, audit } = harness();
    const { forward } = await service.start(SERVICE_ID, undefined, { userId: OWNER_ID });
    expect(await service.revoke(SERVICE_ID, { userId: OWNER_ID }, 'user')).toBe(true);
    expect(service.recordForHostname(new URL(forward.origin).hostname)).toBeNull();
    expect(audit).toContainEqual(expect.objectContaining({ action: 'preview_forward_stop' }));
  });

  it('destroys a tunnel that finishes dialing after the preview is revoked', async () => {
    let resolveDial!: (stream: PassThrough) => void;
    const delayed = new Promise<PassThrough>((resolve) => {
      resolveDial = resolve;
    });
    const dialTcp = vi
      .fn<() => Promise<PassThrough>>()
      .mockResolvedValueOnce(new PassThrough())
      .mockImplementationOnce(() => delayed);
    const { service } = harness({ transport: transport(dialTcp) });
    const { forward } = await service.start(SERVICE_ID, undefined, { userId: OWNER_ID });
    const record = service.recordForHostname(new URL(forward.origin).hostname)!;
    const pendingDial = service.dial(record);

    await service.revoke(SERVICE_ID, { userId: OWNER_ID });
    const late = new PassThrough();
    resolveDial(late);

    await expect(pendingDial).rejects.toBeInstanceOf(PreviewUnavailableError);
    expect(late.destroyed).toBe(true);
  });

  it('coalesces concurrent launch actions without leaking a second allocation or stale token', async () => {
    const tokens = ['initial-preview-capability', 'relaunched-preview-capability'];
    const dialTcp = vi.fn(async () => new PassThrough());
    const { service } = harness({
      transport: transport(dialTcp),
      randomToken: () => tokens.shift()!,
    });

    const [first, duplicate] = await Promise.all([
      service.start(SERVICE_ID, undefined, { userId: OWNER_ID }),
      service.start(SERVICE_ID, undefined, { userId: OWNER_ID }),
    ]);

    expect(duplicate).toEqual(first);
    expect(service.size()).toBe(1);
    expect(dialTcp).toHaveBeenCalledOnce();

    const [relaunched, duplicateRelaunch] = await Promise.all([
      service.relaunch(SERVICE_ID, { userId: OWNER_ID }),
      service.relaunch(SERVICE_ID, { userId: OWNER_ID }),
    ]);
    const record = service.recordForHostname(new URL(first.forward.origin).hostname)!;

    expect(duplicateRelaunch).toEqual(relaunched);
    expect(relaunched.forward.id).toBe(first.forward.id);
    expect(service.authorize(record, 'initial-preview-capability')).toBeNull();
    expect(service.authorize(record, 'relaunched-preview-capability')).not.toBeNull();
  });

  it('reserves global capacity while different services are probing concurrently', async () => {
    let finishProbe!: (stream: PassThrough) => void;
    const pendingProbe = new Promise<PassThrough>((resolve) => {
      finishProbe = resolve;
    });
    const dialTcp = vi.fn(async () => pendingProbe);
    const { service } = harness({
      config: { maxConcurrent: 1 },
      transport: transport(dialTcp),
    });

    const first = service.start(SERVICE_ID, undefined, { userId: OWNER_ID });
    await vi.waitFor(() => expect(dialTcp).toHaveBeenCalledOnce());
    const second = service.start('77777777-7777-4777-8777-777777777777', undefined, {
      userId: OWNER_ID,
    });

    await expect(second).rejects.toBeInstanceOf(PreviewLimitError);
    finishProbe(new PassThrough());
    await expect(first).resolves.toMatchObject({ forward: { health: 'ready' } });
    expect(service.size()).toBe(1);
  });

  it('cannot publish a forward after shutdown invalidates an in-flight probe', async () => {
    let finishProbe!: (stream: PassThrough) => void;
    const pendingProbe = new Promise<PassThrough>((resolve) => {
      finishProbe = resolve;
    });
    const dialTcp = vi.fn(async () => pendingProbe);
    const { service } = harness({ transport: transport(dialTcp) });

    const starting = service.start(SERVICE_ID, undefined, { userId: OWNER_ID });
    await vi.waitFor(() => expect(dialTcp).toHaveBeenCalledOnce());
    service.dispose();
    finishProbe(new PassThrough());

    await expect(starting).rejects.toBeInstanceOf(PreviewUnavailableError);
    expect(service.size()).toBe(0);
  });

  it('relaunches in place while rotating the one-time capability', async () => {
    const tokens = ['first-preview-capability', 'second-preview-capability'];
    const { service } = harness({ randomToken: () => tokens.shift()! });
    const first = await service.start(SERVICE_ID, undefined, { userId: OWNER_ID });
    const record = service.recordForHostname(new URL(first.forward.origin).hostname)!;
    const oldCookieName = service.cookieName(record);
    const relaunched = await service.relaunch(SERVICE_ID, { userId: OWNER_ID });

    expect(relaunched.forward.id).toBe(first.forward.id);
    expect(relaunched.forward.origin).toBe(first.forward.origin);
    expect(service.cookieName(record)).not.toBe(oldCookieName);
    expect(service.authorize(record, 'first-preview-capability')).toBeNull();
    expect(service.authorize(record, 'second-preview-capability')).not.toBeNull();
  });

  it('reuses a released pool slot without accepting its previous capability', async () => {
    const tokens = ['old-slot-capability', 'new-slot-capability'];
    const { service } = harness({
      randomToken: () => tokens.shift()!,
      config: {
        backend: 'port_pool',
        domain: null,
        publicHost: '100.64.0.1',
        publicPort: '',
        portRange: { start: 12000, end: 12000, capacity: 1 },
        embeddingEnabled: true,
        frameSources: ['http://100.64.0.1:12000'],
      },
    });
    const first = await service.start(SERVICE_ID, undefined, { userId: OWNER_ID });
    expect(first.forward.publicPort).toBe(12000);
    await service.revoke(SERVICE_ID, { userId: OWNER_ID });

    const secondId = '77777777-7777-4777-8777-777777777777';
    const second = await service.start(secondId, undefined, { userId: OWNER_ID });
    const record = service.recordForPublicPort(12000)!;
    expect(second.forward.publicPort).toBe(12000);
    expect(service.authorize(record, 'old-slot-capability')).toBeNull();
    expect(service.authorize(record, 'new-slot-capability')).not.toBeNull();
  });
});
