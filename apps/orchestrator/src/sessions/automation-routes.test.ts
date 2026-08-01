/**
 * Automation façade route smoke tests — authz + stub/501 paths without agentd.
 */
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { User } from '@flock/shared';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import {
  registerAutomationRoutes,
  type AutomationSessionInfo,
} from './automation-routes.js';

const SESSION: AutomationSessionInfo = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  status: 'idle',
  agentType: 'codex',
};

const FAKE_USER: User = {
  id: '44444444-4444-4444-8444-444444444444',
  username: 'op',
  createdAt: '2026-05-29T00:00:00.000Z',
  lastLoginAt: null,
  isActive: true,
};

const authStub: AuthGuardDeps = {
  async getUserBySession(sessionId: string): Promise<User | null> {
    return sessionId === 'good-cookie' ? FAKE_USER : null;
  },
};

const cookie = `${SESSION_COOKIE}=good-cookie`;

async function buildApp(opts: {
  session?: AutomationSessionInfo | null;
  scopeProjectId?: string | null;
  waitImplemented?: boolean;
  prompt?: (id: string, text: string) => Promise<void>;
}) {
  const app = Fastify({ logger: false });
  registerAutomationRoutes(app, {
    auth: authStub,
    getSession: async () => (opts.session === undefined ? SESSION : opts.session),
    resolveAutomationScope:
      opts.scopeProjectId === undefined
        ? undefined
        : opts.scopeProjectId === null
          ? () => null
          : () => ({
              projectId: opts.scopeProjectId!,
              sessionId: '33333333-3333-4333-8333-333333333333',
            }),
    waitImplemented: opts.waitImplemented,
    prompt: opts.prompt,
  });
  await app.ready();
  return app;
}

describe('registerAutomationRoutes', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns status-explain for an authed caller', async () => {
    app = await buildApp({});
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${SESSION.id}/status-explain`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ agent: 'codex', state: 'idle' });
  });

  it('denies cross-project automation scope on prompt', async () => {
    app = await buildApp({ scopeProjectId: '99999999-9999-4999-8999-999999999999' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION.id}/prompt`,
      headers: { cookie },
      payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('automation_denied');
  });

  it('allows same-project automation scope and returns 501 when prompt not wired', async () => {
    app = await buildApp({ scopeProjectId: SESSION.projectId });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION.id}/prompt`,
      headers: { cookie },
      payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('automation_not_implemented');
  });

  it('forwards prompt when implementation is provided', async () => {
    const prompt = vi.fn(async () => {});
    app = await buildApp({ scopeProjectId: SESSION.projectId, prompt });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION.id}/prompt`,
      headers: { cookie },
      payload: { text: 'review please' },
    });
    expect(res.statusCode).toBe(200);
    expect(prompt).toHaveBeenCalledWith(SESSION.id, 'review please');
  });

  it('returns 501 for wait when not implemented (after authz)', async () => {
    app = await buildApp({ scopeProjectId: SESSION.projectId, waitImplemented: false });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION.id}/wait`,
      headers: { cookie },
      payload: { timeoutMs: 1000 },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('automation_wait_not_implemented');
  });

  it('returns ok+status for wait when waitImplemented', async () => {
    app = await buildApp({ scopeProjectId: SESSION.projectId, waitImplemented: true });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION.id}/wait`,
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: 'idle', sessionId: SESSION.id });
  });

  it('404s unknown sessions', async () => {
    app = await buildApp({ session: null });
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${SESSION.id}/status-explain`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
