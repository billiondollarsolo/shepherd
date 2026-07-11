import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AuthGuardDeps } from '../auth/middleware.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { registerCollaborationRoutes } from './collaboration-routes.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const auth: AuthGuardDeps = {
  async getUserBySession(value) {
    return value === 'valid'
      ? {
          id: USER_ID,
          username: 'owner',
          displayName: null,
          createdAt: '2026-07-11T00:00:00.000Z',
          lastLoginAt: null,
          isActive: true,
        }
      : null;
  },
};

function app(createSession = vi.fn()) {
  const instance = Fastify();
  registerCollaborationRoutes(instance, {
    auth,
    sessions: { createSession: createSession as never },
    registry: { getSession: vi.fn(async () => null) as never },
    events: { recentChats: vi.fn(async () => []) },
    clientForNode: () => null,
    seedDelayMs: 0,
  });
  return instance;
}

describe('collaboration routes', () => {
  it('requires a human session cookie', async () => {
    const instance = app();
    const response = await instance.inject({ method: 'POST', url: '/api/race', payload: {} });
    expect(response.statusCode).toBe(401);
    await instance.close();
  });

  it('validates a race before creating sessions', async () => {
    const create = vi.fn();
    const instance = app(create);
    const response = await instance.inject({
      method: 'POST',
      url: '/api/race',
      headers: { cookie: `${SESSION_COOKIE}=valid` },
      payload: { projectId: PROJECT_ID, task: '', agentTypes: ['codex'] },
    });
    expect(response.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
    await instance.close();
  });

  it('creates each valid racer independently', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ session: { id: '33333333-3333-4333-8333-333333333333' } })
      .mockResolvedValueOnce({ session: { id: '44444444-4444-4444-8444-444444444444' } });
    const instance = app(create);
    const response = await instance.inject({
      method: 'POST',
      url: '/api/race',
      headers: { cookie: `${SESSION_COOKIE}=valid` },
      payload: { projectId: PROJECT_ID, task: 'Review this', agentTypes: ['codex', 'claude-code'] },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ task: 'Review this', sessionIds: expect.any(Array) });
    expect(create).toHaveBeenCalledTimes(2);
    await instance.close();
  });
});
