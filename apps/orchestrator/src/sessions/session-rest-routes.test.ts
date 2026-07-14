/**
 * Session list/create route tests (FR-S2/S3, NFR-SEC6) — `pnpm test:unit`.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { CreateSessionRequest, SessionRecord, User } from '@flock/shared';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { registerSessionRestRoutes } from './session-rest-routes.js';
import {
  SessionPolicyViolationError,
  SessionProjectNotFoundError,
} from './session-rest-service.js';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
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

function fakeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    nodeId: '22222222-2222-4222-8222-222222222222',
    projectId: PROJECT_ID,
    agentType: 'claude-code',
    tmuxSessionName: 'flock-11111111-1111-4111-8111-111111111111',
    workingDir: '/work',
    hookTokenHash: 'hash:abc',
    status: 'starting',
    statusDetail: null,
    note: null,
    permissionMode: 'default',
    orchestrationAuthority: 'callback_only',
    createdAt: '2026-05-29T00:00:00.000Z',
    lastStatusAt: '2026-05-29T00:00:00.000Z',
    createdBy: FAKE_USER.id,
    closedAt: null,
    ...over,
  };
}

class FakeSessionService {
  listArg: string | undefined;
  notFound = false;
  policyDenied = false;
  async listSessions(projectId?: string): Promise<SessionRecord[]> {
    this.listArg = projectId;
    return [fakeSession()];
  }
  async createSession(input: CreateSessionRequest) {
    if (this.notFound) throw new SessionProjectNotFoundError(input.projectId);
    if (this.policyDenied) throw new SessionPolicyViolationError();
    return { session: fakeSession({ agentType: input.agentType }), hookToken: 'plain-token' };
  }
}

function buildApp(service: FakeSessionService) {
  const app = Fastify({ logger: false });
  registerSessionRestRoutes(app, {
    service: service as unknown as Parameters<typeof registerSessionRestRoutes>[1]['service'],
    auth: authStub,
  });
  return app;
}

describe('GET /api/sessions', () => {
  it('401 without auth', async () => {
    const app = buildApp(new FakeSessionService());
    try {
      expect((await app.inject({ method: 'GET', url: '/api/sessions' })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('passes the ?projectId filter through', async () => {
    const service = new FakeSessionService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions?projectId=${PROJECT_ID}`,
        headers: COOKIE,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sessions).toHaveLength(1);
      expect(res.json().sessions[0]).not.toHaveProperty('hookTokenHash');
      expect(res.json().sessions[0]).not.toHaveProperty('tmuxSessionName');
      expect(res.json().sessions[0]).not.toHaveProperty('createdBy');
      expect(service.listArg).toBe(PROJECT_ID);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/sessions', () => {
  it('201 returns a browser-safe session without agent capability material', async () => {
    const app = buildApp(new FakeSessionService());
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: COOKIE,
        payload: { projectId: PROJECT_ID, agentType: 'codex' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().session.agentType).toBe('codex');
      expect(res.json()).not.toHaveProperty('hookToken');
      expect(res.json().session).not.toHaveProperty('hookTokenHash');
      expect(res.json().session).not.toHaveProperty('tmuxSessionName');
      expect(res.json().session).not.toHaveProperty('createdBy');
    } finally {
      await app.close();
    }
  });

  it('404 when the project is unknown', async () => {
    const service = new FakeSessionService();
    service.notFound = true;
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: COOKIE,
        payload: { projectId: PROJECT_ID, agentType: 'codex' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('project_not_found');
    } finally {
      await app.close();
    }
  });

  it('403 when requested authority exceeds the project policy', async () => {
    const service = new FakeSessionService();
    service.policyDenied = true;
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: COOKIE,
        payload: {
          projectId: PROJECT_ID,
          agentType: 'codex',
          orchestrationAuthority: 'manage',
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('policy_denied');
    } finally {
      await app.close();
    }
  });

  it('400 for an invalid body', async () => {
    const app = buildApp(new FakeSessionService());
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: COOKIE,
        payload: { agentType: 'codex' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
