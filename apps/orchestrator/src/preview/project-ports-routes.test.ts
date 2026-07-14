import Fastify from 'fastify';
import type { User } from '@flock/shared';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../auth/cookie.js';
import type { AuthGuardDeps } from '../auth/middleware.js';
import { registerProjectPortsRoutes } from './project-ports-routes.js';
import { PreviewLimitError } from './service.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const serviceId = '22222222-2222-4222-8222-222222222222';
const user: User = {
  id: '33333333-3333-4333-8333-333333333333',
  username: 'owner',
  createdAt: '2026-07-14T00:00:00.000Z',
  lastLoginAt: null,
  isActive: true,
};
const auth: AuthGuardDeps = {
  getUserBySession: async (cookie) => (cookie === 'valid' ? user : null),
};
const headers = { cookie: `${SESSION_COOKIE}=valid` };

function harness() {
  const ports = {
    list: vi.fn(async () => ({
      ports: [],
      discovery: {
        supported: true,
        healthy: true,
        reason: null,
        observedAt: '2026-07-14T00:00:00.000Z',
        unassignedCount: 0,
        ambiguousCount: 0,
      },
    })),
    activateRemembered: vi.fn(async () => undefined),
    save: vi.fn(),
    update: vi.fn(),
    forget: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    relaunch: vi.fn(async () => ({ port: {}, launchUrl: 'https://preview.example.com' })),
  };
  const previews = {
    deploymentSettings: vi.fn(async () => ({
      deployment: {
        backend: 'disabled',
        deploymentMode: 'development',
        enabled: false,
        reason: 'Not configured',
        publicUrl: null,
        previewDomain: null,
        portRange: null,
        gatewayHealthy: false,
        activeForwards: 0,
        allocatedSlots: 0,
        hardLimits: {
          ttlMs: 60_000,
          maxConcurrent: 1,
          maxConnectionsPerForward: 1,
          maxRequestBytes: 1,
          maxResponseBytes: 1,
        },
        restartRequiredFields: [],
        privateModeWarning: null,
        embeddingEnabled: false,
        embeddingReason: 'Not configured',
        frameSources: [],
      },
      runtime: { enabled: true, defaultTtlMs: 60_000, autoForwardPolicy: 'off' },
    })),
    updateRuntimeSettings: vi.fn(),
    routingTest: vi.fn(async () => ({
      ok: true,
      checkedAt: '2026-07-14T00:00:00.000Z',
      checks: [{ id: 'gateway', status: 'pass', detail: 'Healthy.' }],
    })),
  };
  const app = Fastify({ logger: false });
  registerProjectPortsRoutes(app, {
    ports: ports as unknown as Parameters<typeof registerProjectPortsRoutes>[1]['ports'],
    previews: previews as unknown as Parameters<typeof registerProjectPortsRoutes>[1]['previews'],
    auth,
  });
  return { app, ports, previews };
}

describe('project Ports routes', () => {
  it('requires owner authentication and returns the composite project state', async () => {
    const { app, ports } = harness();
    try {
      expect(
        (await app.inject({ method: 'GET', url: `/api/projects/${projectId}/ports` })).statusCode,
      ).toBe(401);
      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/ports`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().discovery.supported).toBe(true);
      expect(ports.list).toHaveBeenCalledWith(projectId, user.id);
    } finally {
      await app.close();
    }
  });

  it('rejects unsafe manual definitions before reaching the service', async () => {
    const { app, ports } = harness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/ports`,
        headers,
        payload: { targetPort: 80, targetHost: '10.0.0.1', protocol: 'tcp' },
      });
      expect(response.statusCode).toBe(400);
      expect(ports.save).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('exposes explicit relaunch and stable pool exhaustion errors', async () => {
    const { app, ports } = harness();
    try {
      const relaunched = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/ports/${serviceId}/forward/relaunch`,
        headers,
      });
      expect(relaunched.statusCode).toBe(200);
      expect(ports.relaunch).toHaveBeenCalledWith(
        projectId,
        serviceId,
        expect.objectContaining({ userId: user.id }),
      );

      ports.start.mockRejectedValueOnce(new PreviewLimitError('full'));
      const exhausted = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/ports/${serviceId}/forward`,
        headers,
        payload: {},
      });
      expect(exhausted.statusCode).toBe(429);
      expect(exhausted.json().error.code).toBe('pool_exhausted');
    } finally {
      await app.close();
    }
  });

  it('runs the authenticated, redacted routing validation action', async () => {
    const { app, previews } = harness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/settings/deployment-preview/test',
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true });
      expect(previews.routingTest).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.id }),
      );
    } finally {
      await app.close();
    }
  });
});
