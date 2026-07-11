/**
 * US-40 — auditApi unit tests (`pnpm test:unit` web project).
 * Verifies the client calls the owner audit endpoint with credentials, encodes
 * filters into the query string, validates against the shared ListAuditResponse
 * contract, and raises ApiError on failure (incl. 403) / malformed bodies.
 */
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/apiClient';
import { fetchAuditLog } from './auditApi';

const USER_ID = '44444444-4444-4444-8444-444444444444';

function response(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? status : status,
    headers: { 'content-type': 'application/json' },
  });
}

const SAMPLE = {
  id: '11111111-1111-4111-8111-111111111111',
  ts: '2026-05-29T00:00:00.000Z',
  userId: USER_ID,
  action: 'login' as const,
  targetType: 'user',
  targetId: USER_ID,
  ip: '1.2.3.4',
  detail: null,
};

describe('fetchAuditLog (US-40)', () => {
  it('GETs /api/audit with credentials and returns the parsed entries', async () => {
    const fetchImpl = vi.fn(async () => response({ entries: [SAMPLE] }));

    const res = await fetchAuditLog({}, fetchImpl as unknown as typeof fetch);

    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]!.action).toBe('login');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url as string).toContain('/api/audit');
    expect((init as RequestInit).credentials).toBe('include');
    expect((init as RequestInit).method).toBe('GET');
  });

  it('encodes action/userId/limit/offset filters into the query string', async () => {
    const fetchImpl = vi.fn(async () => response({ entries: [] }));
    await fetchAuditLog(
      { action: 'node_remove', userId: USER_ID, limit: 25, offset: 5 },
      fetchImpl as unknown as typeof fetch,
    );
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain('action=node_remove');
    expect(url).toContain(`userId=${USER_ID}`);
    expect(url).toContain('limit=25');
    expect(url).toContain('offset=5');
  });

  it('throws ApiError carrying the server error code on 403', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ error: { code: 'forbidden', message: 'Owner access required.' } }, false, 403),
    );
    await expect(fetchAuditLog({}, fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'forbidden',
    });
  });

  it('throws ApiError on a malformed (contract-violating) body', async () => {
    const fetchImpl = vi.fn(async () => response({ entries: [{ id: 'not-a-uuid' }] }));
    await expect(fetchAuditLog({}, fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
