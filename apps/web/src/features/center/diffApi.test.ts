/**
 * US-33 — diffApi unit tests (`pnpm test:unit`).
 * Verifies the client calls the session-scoped diff endpoint with credentials,
 * validates against the shared DiffResponse contract, and raises DiffApiError on
 * failure / malformed bodies.
 */
import { describe, expect, it, vi } from 'vitest';

import { DiffApiError, fetchSessionDiff } from './diffApi';

// The shared DiffResponse contract validates `sessionId` as a UUID, so the
// fixtures use a real uuid (not a placeholder like "sess-1").
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('fetchSessionDiff (US-33)', () => {
  it('GETs /api/sessions/:id/diff with credentials and returns the parsed response', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        sessionId: SESSION_ID,
        diff: 'diff --git a/f b/f\n',
        generatedAt: '2026-05-29T01:00:00.000Z',
      }),
    );

    const res = await fetchSessionDiff(SESSION_ID, fetchImpl as unknown as typeof fetch);

    expect(res.sessionId).toBe(SESSION_ID);
    expect(res.diff).toContain('diff --git');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url as string).toContain(`/api/sessions/${SESSION_ID}/diff`);
    expect((init as RequestInit).credentials).toBe('include');
    expect((init as RequestInit).method).toBe('GET');
  });

  it('throws DiffApiError carrying the server error code on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ error: { code: 'session_not_found', message: 'nope' } }, false, 404),
    );

    await expect(
      fetchSessionDiff(SESSION_ID, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ name: 'DiffApiError', status: 404, code: 'session_not_found' });
  });

  it('throws DiffApiError on a malformed (contract-violating) body', async () => {
    const fetchImpl = vi.fn(async () => response({ sessionId: SESSION_ID }));

    await expect(
      fetchSessionDiff(SESSION_ID, fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(DiffApiError);
  });
});
