/**
 * Production skill path: HTTP inject through buildServer with wired prompt +
 * authorizeAutomationToken (Bearer / X-Automation-Token), no cookie.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../server.js';

const SESSION = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  status: 'running' as string | null,
  agentType: 'claude' as string | null,
};

const auth = {
  getUserBySession: async () => null, // cookie must not be required for skill path
};

describe('automation skill path via buildServer', () => {
  let app: ReturnType<typeof buildServer> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('POST /prompt with Bearer token hits wired prompt (not 401/501)', async () => {
    const prompt = vi.fn(async () => {});
    app = buildServer({
      auth: auth as never,
      surfaceAuth: auth as never,
      automation: {
        getSession: async () => SESSION,
        authorizeAutomationToken: async (token, required) => {
          expect(token).toBe('orch-token');
          expect(required).toBe('agents:send:project');
          return { projectId: SESSION.projectId, sessionId: 'caller-1' };
        },
        prompt,
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION.id}/prompt`,
      headers: { authorization: 'Bearer orch-token' },
      payload: { text: 'do the thing' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, op: 'session.prompt' });
    expect(prompt).toHaveBeenCalledWith(SESSION.id, 'do the thing');
  });

  it('POST /prompt with X-Automation-Token and wrong project is 403', async () => {
    app = buildServer({
      auth: auth as never,
      surfaceAuth: auth as never,
      automation: {
        getSession: async () => SESSION,
        authorizeAutomationToken: async () => ({
          projectId: '99999999-9999-4999-8999-999999999999',
          sessionId: 'caller',
        }),
        prompt: async () => {},
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${SESSION.id}/prompt`,
      headers: { 'x-automation-token': 'tok' },
      payload: { text: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('index.ts wires authorizeAutomationToken + agentd sessionPrompt', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../index.ts'), 'utf8');
    expect(src).toContain('authorizeAutomationToken');
    expect(src).toContain('agentCapabilities.authorizeToken');
    expect(src).toContain('sessionPrompt');
    expect(src).toContain('sessionWaitStatus');
  });
});
