import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type {
  ConfigureNodeDockerResponse,
  InstallNodeToolResponse,
  NodeCapabilitiesResponse,
  User,
} from '@flock/shared';

import { SESSION_COOKIE } from '../auth/cookie.js';
import type { AuthGuardDeps } from '../auth/middleware.js';
import { NodeCapabilityOperationError } from './node-capabilities.js';
import {
  registerNodeCapabilitiesRoutes,
  type NodeCapabilitiesRouteDeps,
} from './node-capabilities-route.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const user: User = {
  id: USER_ID,
  username: 'owner',
  displayName: null,
  createdAt: '2026-07-15T00:00:00.000Z',
  lastLoginAt: null,
  isActive: true,
};
const auth: AuthGuardDeps = {
  async getUserBySession(id) {
    return id === 'valid' ? user : null;
  },
};
const headers = { cookie: `${SESSION_COOKIE}=valid` };
const docker = {
  installed: true,
  version: 'Docker version 29.1.3',
  daemonRunning: true,
  agentAccess: false,
  accessMode: 'none' as const,
  installSupported: true,
  accessManagementSupported: true,
  reason: null,
};
const amp = {
  id: 'amp' as const,
  agentType: 'amp' as const,
  label: 'Amp',
  binary: 'amp',
  integration: 'basic' as const,
  installed: true,
  path: '/home/flock-agent/.local/bin/amp',
  version: '0.0.1',
  installSupported: true,
  installReason: null,
};
const inventory: NodeCapabilitiesResponse = {
  nodeId: NODE_ID,
  generatedAt: '2026-07-15T00:00:00.000Z',
  tools: [amp],
  docker,
};
const installed: InstallNodeToolResponse = {
  nodeId: NODE_ID,
  tool: 'amp',
  capability: amp,
  summary: 'Amp is ready.',
};
const configured: ConfigureNodeDockerResponse = {
  nodeId: NODE_ID,
  action: 'enable_agent_access',
  docker: { ...docker, agentAccess: true, accessMode: 'system_acl' },
  summary: 'Docker access enabled.',
};

function appFor(overrides: Partial<NodeCapabilitiesRouteDeps> = {}) {
  const app = Fastify();
  registerNodeCapabilitiesRoutes(app, {
    auth,
    inspect: async () => inventory,
    installTool: async () => installed,
    configureDocker: async () => configured,
    ...overrides,
  });
  return app;
}

describe('node capabilities routes', () => {
  it('requires authentication and returns the detected inventory', async () => {
    const app = appFor();
    expect(
      (await app.inject({ method: 'GET', url: `/api/nodes/${NODE_ID}/capabilities` })).statusCode,
    ).toBe(401);

    const response = await app.inject({
      method: 'GET',
      url: `/api/nodes/${NODE_ID}/capabilities`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(inventory);
    await app.close();
  });

  it('installs an allowlisted tool only after exact confirmation', async () => {
    const installTool = vi.fn<NodeCapabilitiesRouteDeps['installTool']>(async () => installed);
    const app = appFor({ installTool });
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/nodes/${NODE_ID}/tools/install`,
      headers,
      payload: { tool: 'amp', confirm: 'yes' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(installTool).not.toHaveBeenCalled();

    const response = await app.inject({
      method: 'POST',
      url: `/api/nodes/${NODE_ID}/tools/install`,
      headers,
      payload: { tool: 'amp', confirm: 'INSTALL' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(installed);
    expect(installTool).toHaveBeenCalledWith(
      NODE_ID,
      'amp',
      expect.objectContaining({ userId: USER_ID }),
    );
    await app.close();
  });

  it('uses different exact confirmations for Docker installation and access', async () => {
    const configureDocker = vi.fn<NodeCapabilitiesRouteDeps['configureDocker']>(
      async () => configured,
    );
    const app = appFor({ configureDocker });
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/nodes/${NODE_ID}/docker`,
      headers,
      payload: { action: 'enable_agent_access', confirm: 'INSTALL DOCKER' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(configureDocker).not.toHaveBeenCalled();

    const response = await app.inject({
      method: 'POST',
      url: `/api/nodes/${NODE_ID}/docker`,
      headers,
      payload: {
        action: 'enable_agent_access',
        confirm: 'DOCKER IS ROOT EQUIVALENT',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(configureDocker).toHaveBeenCalledWith(
      NODE_ID,
      'enable_agent_access',
      expect.objectContaining({ userId: USER_ID }),
    );
    await app.close();
  });

  it('returns a bounded operation error instead of an unexpected response', async () => {
    const app = appFor({
      installTool: async () => {
        throw new NodeCapabilityOperationError(
          'preparation_outdated',
          'Update the node preparation helper.',
        );
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/nodes/${NODE_ID}/tools/install`,
      headers,
      payload: { tool: 'amp', confirm: 'INSTALL' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: {
        code: 'preparation_outdated',
        message: 'Update the node preparation helper.',
      },
    });
    await app.close();
  });
});
