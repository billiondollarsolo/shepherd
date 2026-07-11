/**
 * US-40 — useAuditLog hook tests (web project).
 *
 * Headline criteria (FR-A3): loads the admin audit log on mount, filters by
 * action, and surfaces a `forbidden` flag (admins-only) when the server rejects
 * the read with 403/401 — the authorization decision stays on the server.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useAuditLog } from './useAuditLog';

const USER_ID = '44444444-4444-4444-8444-444444444444';

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function entry(action = 'login') {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    ts: '2026-05-29T00:00:00.000Z',
    userId: USER_ID,
    action,
    targetType: 'user',
    targetId: USER_ID,
    ip: '1.2.3.4',
    detail: null,
  };
}

describe('useAuditLog (US-40)', () => {
  it('loads entries on mount', async () => {
    const fetchImpl = vi.fn(async () => response({ entries: [entry('login')] }));
    const { result } = renderHook(() =>
      useAuditLog({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]!.action).toBe('login');
    expect(result.current.error).toBeNull();
    expect(result.current.forbidden).toBe(false);
  });

  it('re-fetches with the action filter when setAction is called', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      response({
        entries: url.includes('action=node_add') ? [entry('node_add')] : [entry('login')],
      }),
    );
    const { result } = renderHook(() =>
      useAuditLog({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setAction('node_add'));
    await waitFor(() => expect(result.current.action).toBe('node_add'));
    await waitFor(() =>
      expect(result.current.entries.every((e) => e.action === 'node_add')).toBe(true),
    );
    const lastUrl = (fetchImpl.mock.calls.at(-1)![0] as string) ?? '';
    expect(lastUrl).toContain('action=node_add');
  });

  it('sets forbidden when the server rejects a non-admin with 403', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ error: { code: 'forbidden', message: 'Admin role required.' } }, false, 403),
    );
    const { result } = renderHook(() =>
      useAuditLog({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.forbidden).toBe(true);
    expect(result.current.entries).toHaveLength(0);
    expect(result.current.error).toBeTruthy();
  });
});
