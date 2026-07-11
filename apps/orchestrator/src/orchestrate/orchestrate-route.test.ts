import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { RequestBudget } from '../http/request-budget.js';
import { OrchestrationError, type OrchestrationService } from './orchestrate-service.js';
import { registerOrchestrateRoute, type OrchestrationAbuseControls } from './orchestrate-route.js';

const CALLER = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

function makeBudget(overrides: Partial<ConstructorParameters<typeof RequestBudget>[0]> = {}) {
  return new RequestBudget({
    maxRequests: 100,
    windowMs: 60_000,
    maxConcurrent: 20,
    maxConcurrentPerKey: 10,
    ...overrides,
  });
}

function controls(
  overrides: Partial<Record<keyof OrchestrationAbuseControls, RequestBudget>> = {},
): OrchestrationAbuseControls {
  return {
    read: makeBudget(),
    send: makeBudget(),
    destructive: makeBudget(),
    wait: makeBudget(),
    ...overrides,
  };
}

function fakeService(): OrchestrationService {
  return {
    listAgents: vi.fn(async () => []),
    wait: vi.fn(async () => ({ status: 'idle', reached: true })),
    spawn: vi.fn(async () => ({ id: TARGET })),
    send: vi.fn(async () => ({ delivered: true })),
    readOutput: vi.fn(async () => ({ messages: [] })),
    kill: vi.fn(async () => ({ killed: true })),
    restart: vi.fn(async () => ({ id: TARGET })),
  } as unknown as OrchestrationService;
}

describe('agent orchestration abuse policies', () => {
  it('shares a tight destructive budget across spawn, kill, and restart', async () => {
    const app = Fastify();
    const service = fakeService();
    registerOrchestrateRoute(
      app,
      service,
      controls({ destructive: makeBudget({ maxRequests: 1 }) }),
    );
    try {
      const first = await app.inject({
        method: 'POST',
        url: `/api/orchestrate/${CALLER}/spawn`,
        headers: { authorization: 'Bearer token' },
        payload: { agentType: 'codex' },
      });
      expect(first.statusCode).toBe(201);

      const blocked = await app.inject({
        method: 'POST',
        url: `/api/orchestrate/${CALLER}/kill`,
        headers: { authorization: 'Bearer token' },
        payload: { targetId: TARGET },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe('60');
      expect(blocked.json().error.code).toBe('too_many_requests');
      expect(service.kill).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('bounds concurrent long-poll waits per caller', async () => {
    const app = Fastify();
    const service = fakeService();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(service.wait).mockImplementation(async () => {
      await pending;
      return { status: 'idle', reached: true };
    });
    registerOrchestrateRoute(
      app,
      service,
      controls({
        wait: makeBudget({ maxConcurrent: 1, maxConcurrentPerKey: 1 }),
      }),
    );
    try {
      const first = app.inject({
        method: 'GET',
        url: `/api/orchestrate/${CALLER}/wait/${TARGET}`,
        headers: { authorization: 'Bearer token' },
      });
      await vi.waitFor(() => expect(service.wait).toHaveBeenCalledTimes(1));

      const blocked = await app.inject({
        method: 'GET',
        url: `/api/orchestrate/${CALLER}/wait/${TARGET}`,
        headers: { authorization: 'Bearer token' },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe('1');

      finish();
      expect((await first).statusCode).toBe(200);
    } finally {
      finish();
      await app.close();
    }
  });

  it('rejects send bodies over the endpoint-specific limit', async () => {
    const app = Fastify();
    const service = fakeService();
    registerOrchestrateRoute(app, service, controls());
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/orchestrate/${CALLER}/send`,
        headers: { authorization: 'Bearer token' },
        payload: { targetId: TARGET, text: 'x'.repeat(70 * 1024) },
      });
      expect(response.statusCode).toBe(413);
      expect(service.send).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('maps the service spawn window to a consistent 429', async () => {
    const app = Fastify();
    const service = fakeService();
    vi.mocked(service.spawn).mockRejectedValue(
      new OrchestrationError('rate_limited', 'spawn rate limit reached', 5_000),
    );
    registerOrchestrateRoute(app, service, controls());
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/orchestrate/${CALLER}/spawn`,
        headers: { authorization: 'Bearer token' },
        payload: { agentType: 'codex' },
      });
      expect(response.statusCode).toBe(429);
      expect(response.headers['retry-after']).toBe('5');
      expect(response.json().error.code).toBe('too_many_requests');
    } finally {
      await app.close();
    }
  });
});
