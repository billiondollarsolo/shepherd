/**
 * Node CRUD route tests (FR-N1/N2, NFR-SEC6) — `pnpm test:unit`.
 *
 * Fastify `inject` (no real port), with fakes for the auth guard and NodeService
 * so the assertions are about route wiring + validation + status codes only.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { CreateNodeRequest, Node as SharedNode, User } from '@flock/shared';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { registerNodeRoutes } from './node-routes.js';

const USER_ID = '44444444-4444-4444-8444-444444444444';
const FAKE_USER: User = {
  id: USER_ID,
  username: 'op',
  createdAt: '2026-05-29T00:00:00.000Z',
  lastLoginAt: null,
  isActive: true,
};

const authStub: AuthGuardDeps = {
  async getUserBySession(sessionId) {
    return sessionId === 'good-cookie' ? FAKE_USER : null;
  },
};

function fakeNode(over: Partial<SharedNode> = {}): SharedNode {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'local',
    kind: 'local',
    host: null,
    port: null,
    sshUser: null,
    sshKeyRef: null,
    connectionStatus: 'connected',
    lastSeenAt: null,
    createdBy: USER_ID,
    createdAt: '2026-05-29T00:00:00.000Z',
    ...over,
  };
}

class FakeNodeService {
  created: CreateNodeRequest[] = [];
  deleted: string[] = [];
  deleteResult = true;
  async listNodes(): Promise<SharedNode[]> {
    return [fakeNode()];
  }
  async createNode(input: CreateNodeRequest): Promise<SharedNode> {
    this.created.push(input);
    return fakeNode({ name: input.name, kind: input.kind });
  }
  async deleteNode(id: string): Promise<boolean> {
    this.deleted.push(id);
    return this.deleteResult;
  }
}

function buildApp(service: FakeNodeService) {
  const app = Fastify({ logger: false });
  registerNodeRoutes(app, {
    service: service as unknown as Parameters<typeof registerNodeRoutes>[1]['service'],
    auth: authStub,
  });
  return app;
}

const COOKIE = { cookie: `${SESSION_COOKIE}=good-cookie` };

describe('GET /api/nodes', () => {
  it('401 without auth', async () => {
    const app = buildApp(new FakeNodeService());
    try {
      const res = await app.inject({ method: 'GET', url: '/api/nodes' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns { nodes: [...] } when authed', async () => {
    const app = buildApp(new FakeNodeService());
    try {
      const res = await app.inject({ method: 'GET', url: '/api/nodes', headers: COOKIE });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().nodes)).toBe(true);
      expect(res.json().nodes[0].kind).toBe('local');
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/nodes', () => {
  it('201 + { node } for a valid local node', async () => {
    const service = new FakeNodeService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/nodes',
        headers: COOKIE,
        payload: { name: 'box', kind: 'local' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().node.name).toBe('box');
      expect(service.created).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('400 for an ssh node missing required fields (shared schema)', async () => {
    const service = new FakeNodeService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/nodes',
        headers: COOKIE,
        payload: { name: 'edge', kind: 'ssh' },
      });
      expect(res.statusCode).toBe(400);
      expect(service.created).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

describe('DELETE /api/nodes/:id', () => {
  it('204 on success', async () => {
    const service = new FakeNodeService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/nodes/11111111-1111-4111-8111-111111111111',
        headers: COOKIE,
      });
      expect(res.statusCode).toBe(204);
      expect(service.deleted).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('404 when the node is unknown', async () => {
    const service = new FakeNodeService();
    service.deleteResult = false;
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/nodes/11111111-1111-4111-8111-111111111111',
        headers: COOKIE,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('400 for a malformed id', async () => {
    const service = new FakeNodeService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/nodes/not-a-uuid',
        headers: COOKIE,
      });
      expect(res.statusCode).toBe(400);
      expect(service.deleted).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
