import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { User } from '@flock/shared';

import { SESSION_COOKIE } from '../../auth/cookie.js';
import type { AuthGuardDeps } from '../../auth/middleware.js';
import {
  registerNodeAgentdUpgradeRoute,
  type NodeAgentdUpgradeResult,
} from './agentd-upgrade-route.js';

const nodeId = '11111111-1111-4111-8111-111111111111';
const user: User = {
  id: '44444444-4444-4444-8444-444444444444',
  username: 'owner',
  displayName: null,
  createdAt: '2026-07-11T00:00:00.000Z',
  lastLoginAt: null,
  isActive: true,
};
const auth: AuthGuardDeps = {
  async getUserBySession(id) {
    return id === 'valid' ? user : null;
  },
};

function appFor(result: NodeAgentdUpgradeResult) {
  const app = Fastify();
  registerNodeAgentdUpgradeRoute(app, { auth, upgrade: async () => result });
  return app;
}

describe('node daemon upgrade route', () => {
  it('requires authentication and explicit destructive confirmation', async () => {
    const app = appFor({ status: 'upgraded' });
    expect(
      (await app.inject({ method: 'POST', url: `/api/nodes/${nodeId}/upgrade-agentd` })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/nodes/${nodeId}/upgrade-agentd`,
          headers: { cookie: `${SESSION_COOKIE}=valid` },
          payload: { confirm: 'no' },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it.each([
    [{ status: 'upgraded' }, 200],
    [{ status: 'active_sessions', count: 2 }, 409],
    [{ status: 'not_found' }, 404],
    [{ status: 'not_remote' }, 409],
    [{ status: 'unavailable' }, 409],
  ] as const)('maps $0 to $1', async (result, status) => {
    const app = appFor(result);
    const response = await app.inject({
      method: 'POST',
      url: `/api/nodes/${nodeId}/upgrade-agentd`,
      headers: { cookie: `${SESSION_COOKIE}=valid` },
      payload: { confirm: 'UPGRADE' },
    });
    expect(response.statusCode).toBe(status);
    if (status === 200) expect(response.json()).toEqual({ nodeId, upgraded: true });
    if (result.status === 'active_sessions') {
      expect(response.json().error.details).toEqual({ count: 2 });
    }
    await app.close();
  });
});
