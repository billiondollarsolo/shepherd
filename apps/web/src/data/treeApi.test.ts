import { afterEach, describe, expect, it, vi } from 'vitest';

import { terminateSession } from './treeApi';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

describe('treeApi session termination contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts the canonical 200 termination response body', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            sessionId: SESSION_ID,
            terminated: true,
            closedAt: '2026-07-14T21:30:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(terminateSession(SESSION_ID)).resolves.toEqual({
      sessionId: SESSION_ID,
      terminated: true,
      closedAt: '2026-07-14T21:30:00.000Z',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/sessions/${SESSION_ID}`,
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    );
  });
});
