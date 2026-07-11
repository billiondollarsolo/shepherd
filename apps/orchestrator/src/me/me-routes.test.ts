import { describe, expect, it, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { User, ProjectLayoutV1, ProjectPensV1 } from '@flock/shared';
import { SESSION_COOKIE } from '../auth/cookie.js';
import type { AuthGuardDeps } from '../auth/middleware.js';
import { registerMeRoutes } from './me-routes.js';

const FAKE_USER: User = {
  id: '44444444-4444-4444-8444-444444444444',
  username: 'alice',
  role: 'admin',
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

describe('me routes — presets / layout / Pens', () => {
  const layouts = new Map<string, ProjectLayoutV1>();
  const pens = new Map<string, ProjectPensV1>();
  const presets = new Map<string, unknown[]>();

  beforeEach(() => {
    layouts.clear();
    pens.clear();
    presets.clear();
  });

  function buildApp() {
    const f = Fastify({ logger: false });
    registerMeRoutes(f, {
      auth: authStub,
      getPresets: async (uid) => (presets.get(uid) as never) ?? [],
      putPresets: async (uid, p) => {
        presets.set(uid, p);
      },
      getLayout: async (id) => layouts.get(id) ?? null,
      putLayout: async (id, layout) => {
        layouts.set(id, layout);
      },
      getPens: async (_userId, id) => pens.get(id) ?? null,
      putPens: async (_userId, id, value) => {
        pens.set(id, value);
      },
    });
    return f;
  }

  it('requires authentication', async () => {
    const f = buildApp();
    try {
      const response = await f.inject({ method: 'GET', url: '/api/me/launcher-presets' });
      expect(response.statusCode).toBe(401);
    } finally {
      await f.close();
    }
  });

  it('launcher presets include builtins and accept user presets', async () => {
    const f = buildApp();
    try {
      const get = await f.inject({
        method: 'GET',
        url: '/api/me/launcher-presets',
        headers: COOKIE,
      });
      expect(get.statusCode).toBe(200);
      expect(get.json().presets.length).toBeGreaterThan(0);
      expect(
        get.json().presets.some((p: { agentType: string }) => p.agentType === 'claude-code'),
      ).toBe(true);

      const put = await f.inject({
        method: 'PUT',
        url: '/api/me/launcher-presets',
        headers: COOKIE,
        payload: {
          presets: [{ id: 'mine', name: 'My Claude', agentType: 'claude-code' }],
        },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().presets.some((p: { id: string }) => p.id === 'mine')).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('project layout PUT/GET with project-scoped body', async () => {
    const f = buildApp();
    try {
      const layout = {
        version: 1 as const,
        projectId: 'proj-1',
        focusedLeafId: 'leaf-a',
        zoomedLeafId: null,
        root: {
          type: 'leaf' as const,
          id: 'leaf-a',
          kind: 'session' as const,
          sessionId: 'sess-a',
        },
      };
      const put = await f.inject({
        method: 'PUT',
        url: '/api/projects/proj-1/layout',
        headers: COOKIE,
        payload: layout,
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().layout.focusedLeafId).toBe('leaf-a');

      const get = await f.inject({
        method: 'GET',
        url: '/api/projects/proj-1/layout',
        headers: COOKIE,
      });
      expect(get.json().layout.root.sessionId).toBe('sess-a');
    } finally {
      await f.close();
    }
  });

  it('project Pens PUT/GET persists multiple layouts', async () => {
    const f = buildApp();
    try {
      const leaf = (sessionId: string) => ({
        version: 1 as const,
        projectId: 'proj-1',
        focusedLeafId: `leaf-${sessionId}`,
        root: {
          type: 'leaf' as const,
          id: `leaf-${sessionId}`,
          kind: 'session' as const,
          sessionId,
        },
      });
      const payload = {
        version: 1 as const,
        projectId: 'proj-1',
        activePenId: 'pen-2',
        pens: [
          { id: 'pen-1', name: 'Pen 1', layout: leaf('a') },
          { id: 'pen-2', name: 'Pen 2', layout: leaf('b') },
        ],
      };
      const put = await f.inject({
        method: 'PUT',
        url: '/api/projects/proj-1/pens',
        headers: COOKIE,
        payload,
      });
      expect(put.statusCode).toBe(200);
      const get = await f.inject({
        method: 'GET',
        url: '/api/projects/proj-1/pens',
        headers: COOKIE,
      });
      expect(get.json().pens.pens).toHaveLength(2);
      expect(get.json().pens.activePenId).toBe('pen-2');
    } finally {
      await f.close();
    }
  });
});
