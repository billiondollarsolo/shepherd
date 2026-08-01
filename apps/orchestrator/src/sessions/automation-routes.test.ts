/**
 * Automation façade route tests — cookie + skill token auth, authz, and wired bridges.
 */
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { User } from '@flock/shared';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import {
  registerAutomationRoutes,
  scopeForAutomationAction,
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
  displayName: null,
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
  waitStatus?: (
    id: string,
    until: string[] | undefined,
    timeoutMs: number,
  ) => Promise<string>;
  sendKeys?: (id: string, keys: string[]) => Promise<void>;
  authorizeAutomationToken?: (
    token: string,
    required: string,
  ) => Promise<{ projectId: string; sessionId: string } | null>;
  readScreen?: (id: string) => Promise<string>;
  waitOutput?: (
    id: string,
    opts: { match?: string; regex?: string; timeoutMs?: number },
  ) => Promise<{ matchedLine: string }>;
}) {
  const app = Fastify({ logger: false });
  registerAutomationRoutes(app, {
    auth: authStub,
    getSession: async () => (opts.session === undefined ? SESSION : opts.session),
    waitImplemented: opts.waitImplemented,
    prompt: opts.prompt,
    waitStatus: opts.waitStatus,
    sendKeys: opts.sendKeys,
    authorizeAutomationToken: opts.authorizeAutomationToken as never,
    readScreen: opts.readScreen,
    waitOutput: opts.waitOutput,
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

  it('returns status-explain for an authed cookie caller', async () => {
    app = await buildApp({});
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${SESSION.id}/status-explain`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ agent: 'codex', state: 'idle' });
  });

  it('401 without cookie or automation token', async () => {
    app = await buildApp({});
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${SESSION.id}/status-explain`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('skill path: Bearer token + authorizeAutomationToken forwards prompt (200)', async () => {
    const prompt = vi.fn(async () => {});
    const authorizeAutomationToken = vi.fn(async (token: string) => {
      if (token !== 'good-orch-token') return null;
      return { projectId: SESSION.projectId, sessionId: 'caller-sess' };
    });
    app = await buildApp({ prompt, authorizeAutomationToken });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION.id}/prompt`,
      headers: { authorization: 'Bearer good-orch-token' },
      payload: { text: 'review please' },
    });
    expect(res.statusCode).toBe(200);
    expect(prompt).toHaveBeenCalledWith(SESSION.id, 'review please');
    expect(authorizeAutomationToken).toHaveBeenCalledWith(
      'good-orch-token',
      scopeForAutomationAction('prompt'),
    );
  });

  it('skill path: X-Automation-Token works without cookie', async () => {
    const prompt = vi.fn(async () => {});
    app = await buildApp({
      prompt,
      authorizeAutomationToken: async () => ({
        projectId: SESSION.projectId,
        sessionId: 'caller',
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION.id}/prompt`,
      headers: { 'x-automation-token': 'tok' },
      payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(200);
    expect(prompt).toHaveBeenCalled();
  });

  it('denies cross-project automation token on prompt', async () => {
    app = await buildApp({
      authorizeAutomationToken: async () => ({
        projectId: '99999999-9999-4999-8999-999999999999',
        sessionId: 'caller',
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION.id}/prompt`,
      headers: { authorization: 'Bearer tok' },
      payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('automation_denied');
  });

  it('401 when automation token fails authorize', async () => {
    app = await buildApp({
      authorizeAutomationToken: async () => null,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION.id}/prompt`,
      headers: { authorization: 'Bearer bad' },
      payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('cookie path: returns 501 when prompt not wired', async () => {
    app = await buildApp({});
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION.id}/prompt`,
      headers: { cookie },
      payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(501);
  });

  it('forwards waitStatus bridge with token auth', async () => {
    const waitStatus = vi.fn(async () => 'awaiting_input');
    app = await buildApp({
      waitStatus,
      authorizeAutomationToken: async () => ({
        projectId: SESSION.projectId,
        sessionId: 'c',
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION.id}/wait`,
      headers: { authorization: 'Bearer t' },
      payload: { until: ['awaiting_input'], timeoutMs: 5000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: 'awaiting_input' });
    expect(waitStatus).toHaveBeenCalledWith(SESSION.id, ['awaiting_input'], 5000);
  });

  it('forwards sendKeys with token auth', async () => {
    const sendKeys = vi.fn(async () => {});
    app = await buildApp({
      sendKeys,
      authorizeAutomationToken: async () => ({
        projectId: SESSION.projectId,
        sessionId: 'c',
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION.id}/keys`,
      headers: { 'x-automation-token': 't' },
      payload: { keys: ['esc', 'enter'] },
    });
    expect(res.statusCode).toBe(200);
    expect(sendKeys).toHaveBeenCalledWith(SESSION.id, ['esc', 'enter']);
  });

  it('GET /screen with token returns text from readScreen bridge', async () => {
    const readScreen = vi.fn(async () => 'visible pane text');
    app = await buildApp({
      readScreen,
      authorizeAutomationToken: async () => ({
        projectId: SESSION.projectId,
        sessionId: 'c',
      }),
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${SESSION.id}/screen`,
      headers: { authorization: 'Bearer t' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, text: 'visible pane text' });
    expect(readScreen).toHaveBeenCalledWith(SESSION.id);
  });

  it('POST /wait-output with token waits via bridge', async () => {
    const waitOutput = vi.fn(async () => ({ matchedLine: 'found LINE' }));
    app = await buildApp({
      waitOutput,
      authorizeAutomationToken: async () => ({
        projectId: SESSION.projectId,
        sessionId: 'c',
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION.id}/wait-output`,
      headers: { 'x-automation-token': 't' },
      payload: { match: 'LINE', timeoutMs: 5000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, matchedLine: 'found LINE' });
    expect(waitOutput).toHaveBeenCalledWith(SESSION.id, {
      match: 'LINE',
      regex: undefined,
      timeoutMs: 5000,
    });
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

describe('scopeForAutomationAction', () => {
  it('maps verbs to capability scopes', () => {
    expect(scopeForAutomationAction('prompt')).toBe('agents:send:project');
    expect(scopeForAutomationAction('wait')).toBe('agents:read:project');
    expect(scopeForAutomationAction('read')).toBe('agents:read:project');
    expect(scopeForAutomationAction('create')).toBe('agents:spawn:project');
  });
});
