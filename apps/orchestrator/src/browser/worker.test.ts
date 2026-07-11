import { describe, expect, it, vi } from 'vitest';
import { buildBrowserWorker } from './worker';

const token = 'x'.repeat(32);
const id = '11111111-1111-4111-8111-111111111111';

describe('browser worker allowlist', () => {
  it('permits only authenticated fixed lifecycle operations', async () => {
    const lifecycle = {
      launch: vi.fn(async (sessionId: string) => ({
        sessionId,
        containerId: 'container',
        cdpEndpoint: 'ws://browser:9222/devtools/browser/id',
        startedAt: new Date(0),
      })),
      stop: vi.fn(async () => true),
      reap: vi.fn(async () => ['orphan']),
      stopAll: vi.fn(async () => undefined),
    };
    const app = buildBrowserWorker(lifecycle, token);
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/v1/browsers', payload: { sessionId: id } }))
          .statusCode,
      ).toBe(401);
      const headers = { authorization: `Bearer ${token}` };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/browsers',
            headers,
            payload: { sessionId: id },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/browsers',
            headers,
            payload: { sessionId: id, privileged: true },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ method: 'POST', url: '/containers/create', headers, payload: {} }))
          .statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: 'DELETE', url: `/v1/browsers/${id}`, headers })).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });
});
