/**
 * US-33.1 — git source-control route tests (run under `pnpm test:unit`).
 *
 * Fastify `inject` (no real port) with fakes for the auth guard + GitService, so
 * the assertions are about route wiring:
 *   - unauthenticated callers get 401 (NFR-SEC6) and the service is NOT called;
 *   - status/stage/unstage/commit/push reach the service and return its payload;
 *   - commit forwards the acting user's identity + rejects an empty message (400);
 *   - DiffSessionNotFoundError → 404 and GitOperationError → 422.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { User } from '@flock/shared';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { registerGitRoutes } from './git-route.js';
import { DiffSessionNotFoundError } from './diff-service.js';
import { GitOperationError, type GitIdentity } from './git-service.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

const FAKE_USER: User = {
  id: '44444444-4444-4444-8444-444444444444',
  username: 'op@example.com',
  role: 'admin',
  createdAt: '2026-05-29T00:00:00.000Z',
  lastLoginAt: null,
  isActive: true,
};

const authStub: AuthGuardDeps = {
  async getUserBySession(sessionId: string): Promise<User | null> {
    return sessionId === 'good-cookie' ? FAKE_USER : null;
  },
};

const STATUS = {
  sessionId: SESSION_ID,
  branch: 'main',
  upstream: 'origin/main',
  ahead: 1,
  behind: 0,
  hasHead: true,
  files: [],
  generatedAt: '2026-05-29T01:00:00.000Z',
};

class FakeGitService {
  stageCalls: Array<{ id: string; paths: string[] }> = [];
  commitCalls: Array<{ id: string; message: string; identity: GitIdentity }> = [];
  pushCalls: string[] = [];
  outcome: 'ok' | 'notFound' | 'opError' = 'ok';

  private guard(id: string) {
    if (this.outcome === 'notFound') throw new DiffSessionNotFoundError(id);
    if (this.outcome === 'opError') throw new GitOperationError('not a git repository');
  }
  async status(id: string) {
    this.guard(id);
    return STATUS;
  }
  async stage(id: string, paths: string[]) {
    this.guard(id);
    this.stageCalls.push({ id, paths });
    return STATUS;
  }
  async unstage(id: string, paths: string[]) {
    this.guard(id);
    this.stageCalls.push({ id, paths });
    return STATUS;
  }
  async commit(id: string, message: string, identity: GitIdentity) {
    this.guard(id);
    this.commitCalls.push({ id, message, identity });
    return {
      sessionId: id,
      committed: true,
      sha: 'abc123',
      detail: message,
      generatedAt: '2026-05-29T01:00:00.000Z',
    };
  }
  async push(id: string) {
    this.guard(id);
    this.pushCalls.push(id);
    return { sessionId: id, pushed: true as const, detail: 'ok', generatedAt: '2026-05-29T01:00:00.000Z' };
  }
}

function buildApp(service: FakeGitService) {
  const app = Fastify({ logger: false });
  registerGitRoutes(app, {
    service: service as unknown as Parameters<typeof registerGitRoutes>[1]['service'],
    auth: authStub,
  });
  return app;
}

const authed = { cookie: `${SESSION_COOKIE}=good-cookie` };

describe('git source-control routes (US-33.1)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const service = new FakeGitService();
    const app = buildApp(service);
    try {
      const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/git/status` });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('GET status returns the file list', async () => {
    const app = buildApp(new FakeGitService());
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${SESSION_ID}/git/status`,
        headers: authed,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().branch).toBe('main');
    } finally {
      await app.close();
    }
  });

  it('POST stage forwards the paths', async () => {
    const service = new FakeGitService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/sessions/${SESSION_ID}/git/stage`,
        headers: authed,
        payload: { paths: ['a.ts', 'b.ts'] },
      });
      expect(res.statusCode).toBe(200);
      expect(service.stageCalls[0]).toEqual({ id: SESSION_ID, paths: ['a.ts', 'b.ts'] });
    } finally {
      await app.close();
    }
  });

  it('POST commit forwards the acting user identity (email username → kept)', async () => {
    const service = new FakeGitService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/sessions/${SESSION_ID}/git/commit`,
        headers: authed,
        payload: { message: '  hello  ' },
      });
      expect(res.statusCode).toBe(200);
      expect(service.commitCalls[0]).toMatchObject({
        message: 'hello', // trimmed
        identity: { name: 'op@example.com', email: 'op@example.com' },
      });
    } finally {
      await app.close();
    }
  });

  it('POST commit rejects an empty/whitespace message with 400', async () => {
    const service = new FakeGitService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/sessions/${SESSION_ID}/git/commit`,
        headers: authed,
        payload: { message: '   ' },
      });
      expect(res.statusCode).toBe(400);
      expect(service.commitCalls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('POST push reaches the service', async () => {
    const service = new FakeGitService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/sessions/${SESSION_ID}/git/push`,
        headers: authed,
      });
      expect(res.statusCode).toBe(200);
      expect(service.pushCalls).toEqual([SESSION_ID]);
    } finally {
      await app.close();
    }
  });

  it('maps an unknown session to 404', async () => {
    const service = new FakeGitService();
    service.outcome = 'notFound';
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${SESSION_ID}/git/status`,
        headers: authed,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('session_not_found');
    } finally {
      await app.close();
    }
  });

  it('maps a git operation failure to 422', async () => {
    const service = new FakeGitService();
    service.outcome = 'opError';
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/sessions/${SESSION_ID}/git/push`,
        headers: authed,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('git_unavailable');
    } finally {
      await app.close();
    }
  });
});
