/**
 * Project CRUD route tests (FR-N3, NFR-SEC6) — `pnpm test:unit`.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROJECT_AGENT_POLICY,
  type CreateProjectRequest,
  type Project as SharedProject,
  type ProjectAgentPolicy,
  type User,
} from '@flock/shared';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { registerProjectRoutes } from './project-routes.js';
import { ProjectNodeNotFoundError } from './project-service.js';

const NODE_ID = '22222222-2222-4222-8222-222222222222';
const FAKE_USER: User = {
  id: '44444444-4444-4444-8444-444444444444',
  username: 'op',
  createdAt: '2026-05-29T00:00:00.000Z',
  lastLoginAt: null,
  isActive: true,
};
const authStub: AuthGuardDeps = {
  async getUserBySession(s) {
    return s === 'good-cookie' ? FAKE_USER : null;
  },
};
const COOKIE = { cookie: `${SESSION_COOKIE}=good-cookie` };

function fakeProject(over: Partial<SharedProject> = {}): SharedProject {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    nodeId: NODE_ID,
    name: 'flock',
    workingDir: '/work',
    agentPolicy: DEFAULT_PROJECT_AGENT_POLICY,
    createdAt: '2026-05-29T00:00:00.000Z',
    ...over,
  };
}

class FakeProjectService {
  listArg: string | undefined;
  notFound = false;
  async listProjects(nodeId?: string): Promise<SharedProject[]> {
    this.listArg = nodeId;
    return [fakeProject()];
  }
  async createProject(input: CreateProjectRequest): Promise<SharedProject> {
    if (this.notFound) throw new ProjectNodeNotFoundError(input.nodeId);
    return fakeProject({ name: input.name, workingDir: input.workingDir });
  }
  async updateAgentPolicy(
    _projectId: string,
    policy: ProjectAgentPolicy,
  ): Promise<SharedProject | null> {
    if (this.notFound) return null;
    return fakeProject({ agentPolicy: policy });
  }
}

function buildApp(service: FakeProjectService) {
  const app = Fastify({ logger: false });
  registerProjectRoutes(app, {
    service: service as unknown as Parameters<typeof registerProjectRoutes>[1]['service'],
    auth: authStub,
  });
  return app;
}

describe('GET /api/projects', () => {
  it('401 without auth', async () => {
    const app = buildApp(new FakeProjectService());
    try {
      expect((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('passes the ?nodeId filter through', async () => {
    const service = new FakeProjectService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects?nodeId=${NODE_ID}`,
        headers: COOKIE,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().projects).toHaveLength(1);
      expect(service.listArg).toBe(NODE_ID);
    } finally {
      await app.close();
    }
  });
});

describe('PATCH /api/projects/:id/agent-policy', () => {
  it('validates and replaces the complete durable policy', async () => {
    const app = buildApp(new FakeProjectService());
    try {
      const policy = { ...DEFAULT_PROJECT_AGENT_POLICY, maxAuthority: 'collaborate' as const };
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/projects/33333333-3333-4333-8333-333333333333/agent-policy',
        headers: COOKIE,
        payload: policy,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().project.agentPolicy.maxAuthority).toBe('collaborate');
    } finally {
      await app.close();
    }
  });

  it('rejects a default that exceeds the maximum', async () => {
    const app = buildApp(new FakeProjectService());
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/projects/33333333-3333-4333-8333-333333333333/agent-policy',
        headers: COOKIE,
        payload: {
          ...DEFAULT_PROJECT_AGENT_POLICY,
          defaultAuthority: 'manage',
          maxAuthority: 'observe',
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/projects', () => {
  it('201 + { project } for a valid body', async () => {
    const app = buildApp(new FakeProjectService());
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: COOKIE,
        payload: { nodeId: NODE_ID, name: 'flock', workingDir: '/work' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().project.name).toBe('flock');
    } finally {
      await app.close();
    }
  });

  it('404 when the node is unknown', async () => {
    const service = new FakeProjectService();
    service.notFound = true;
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: COOKIE,
        payload: { nodeId: NODE_ID, name: 'flock', workingDir: '/work' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('node_not_found');
    } finally {
      await app.close();
    }
  });

  it('400 for an invalid body', async () => {
    const app = buildApp(new FakeProjectService());
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: COOKIE,
        payload: { name: 'no-node' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
