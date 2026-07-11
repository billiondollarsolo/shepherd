import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { User } from '@flock/shared';

import { SESSION_COOKIE } from '../../auth/cookie.js';
import type { AuthGuardDeps } from '../../auth/middleware.js';
import {
  registerNodeCredentialRotationRoute,
  type NodeCredentialRotationResult,
} from './credential-rotation-route.js';

const nodeId = '11111111-1111-4111-8111-111111111111';
const user: User = {
  id: '44444444-4444-4444-8444-444444444444',
  username: 'owner',
  displayName: null,
  role: 'admin',
  createdAt: '2026-07-11T00:00:00.000Z',
  lastLoginAt: null,
  isActive: true,
};
const auth: AuthGuardDeps = {
  async getUserBySession(id) {
    return id === 'valid' ? user : null;
  },
};

function appFor(result: NodeCredentialRotationResult) {
  const app = Fastify();
  registerNodeCredentialRotationRoute(app, { auth, rotate: async () => result });
  return app;
}

describe('node credential rotation route', () => {
  it('requires an owner session and validates the node id', async () => {
    const app = appFor('rotated');
    expect(
      (await app.inject({ method: 'POST', url: `/api/nodes/${nodeId}/rotate-control-credential` }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/nodes/not-an-id/rotate-control-credential',
          headers: { cookie: `${SESSION_COOKIE}=valid` },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it.each([
    ['rotated', 200],
    ['not_found', 404],
    ['unavailable', 409],
  ] as const)('maps %s to %s', async (result, status) => {
    const app = appFor(result);
    const response = await app.inject({
      method: 'POST',
      url: `/api/nodes/${nodeId}/rotate-control-credential`,
      headers: { cookie: `${SESSION_COOKIE}=valid` },
    });
    expect(response.statusCode).toBe(status);
    if (status === 200) expect(response.json()).toEqual({ nodeId, rotated: true });
    await app.close();
  });
});
