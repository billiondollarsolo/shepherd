/**
 * US-40 — AuditLogView smoke (web project, FR-A3).
 * Renders the admin audit table from the injected fetch, filters by action, and
 * shows the admins-only message when the server rejects a non-admin (403).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AuditLogView } from './AuditLogView';

const USER_ID = '44444444-4444-4444-8444-444444444444';

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function entry(action: string, id: string) {
  return {
    id,
    ts: '2026-05-29T00:00:00.000Z',
    userId: USER_ID,
    action,
    targetType: 'user',
    targetId: USER_ID,
    ip: '1.2.3.4',
    detail: null,
  };
}

describe('AuditLogView (US-40)', () => {
  it('renders the audit rows returned by the endpoint', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        entries: [
          entry('login', '11111111-1111-4111-8111-111111111111'),
          entry('node_add', '22222222-2222-4222-8222-222222222222'),
        ],
      }),
    );

    render(<AuditLogView fetchImpl={fetchImpl as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId('audit-table')).toBeTruthy());
    expect(screen.getAllByTestId('audit-row')).toHaveLength(2);
  });

  it('filters by action via the dropdown (re-requests with action=...)', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      response({
        entries: url.includes('action=node_remove')
          ? [entry('node_remove', '33333333-3333-4333-8333-333333333333')]
          : [entry('login', '11111111-1111-4111-8111-111111111111')],
      }),
    );

    render(<AuditLogView fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await waitFor(() => expect(screen.getByTestId('audit-table')).toBeTruthy());

    fireEvent.change(screen.getByTestId('audit-action-filter'), {
      target: { value: 'node_remove' },
    });

    await waitFor(() => {
      const lastUrl = (fetchImpl.mock.calls.at(-1)![0] as string) ?? '';
      expect(lastUrl).toContain('action=node_remove');
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId('audit-row');
      expect(rows.every((r) => r.getAttribute('data-action') === 'node_remove')).toBe(true);
    });
  });

  it('shows an admins-only message when the server rejects a non-admin (403)', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ error: { code: 'forbidden', message: 'Admin role required.' } }, false, 403),
    );

    render(<AuditLogView fetchImpl={fetchImpl as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId('audit-forbidden')).toBeTruthy());
    expect(screen.queryByTestId('audit-table')).toBeNull();
  });
});
