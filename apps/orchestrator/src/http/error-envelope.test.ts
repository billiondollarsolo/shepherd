/**
 * Roadmap F2 — the global error handler returns the shared envelope for every
 * error, including uncaught ones, and never leaks a 5xx internal message.
 */
import { describe, expect, it } from 'vitest';
import { FlockErrorEnvelope } from '@flock/shared';
import { buildServer } from '../server.js';

describe('global error envelope (F2)', () => {
  it('unknown route → 404 envelope', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/no-such-route' });
    expect(res.statusCode).toBe(404);
    const body = FlockErrorEnvelope.parse(res.json());
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain('/no-such-route');
    await app.close();
  });

  it('uncaught route error → 500 envelope WITHOUT leaking the internal message', async () => {
    const app = buildServer();
    app.get('/boom', async () => {
      throw new Error('secret internal detail');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    const body = FlockErrorEnvelope.parse(res.json());
    expect(body.error.code).toBe('internal');
    expect(JSON.stringify(body)).not.toContain('secret internal detail');
    await app.close();
  });
});
