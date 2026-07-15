/**
 * US-40 — AuditLogView smoke (web project, FR-A3).
 * Renders the owner audit table from the injected fetch, filters by action, and
 * shows the access-denied message when the server rejects the request (403).
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AuditLogView } from './AuditLogView';

const USER_ID = '44444444-4444-4444-8444-444444444444';

function response(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? status : status,
    headers: { 'content-type': 'application/json' },
  });
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

  it('renders the action filter as a labelled Select defaulting to all actions', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ entries: [entry('login', '11111111-1111-4111-8111-111111111111')] }),
    );

    render(<AuditLogView fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await waitFor(() => expect(screen.getByTestId('audit-table')).toBeTruthy());

    // The native <select> was replaced by the ui Select primitive (a combobox
    // trigger). The re-request-on-filter behaviour is covered by useAuditLog.test.ts.
    const filter = screen.getByRole('combobox', { name: 'Filter by action' });
    expect(filter).toBeTruthy();
    expect(filter).toHaveTextContent(/all actions/i);
  });

  it('shows an access-denied empty state when the server rejects the request (403)', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ error: { code: 'forbidden', message: 'Owner access required.' } }, false, 403),
    );

    render(<AuditLogView fetchImpl={fetchImpl as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId('audit-forbidden')).toBeTruthy());
    expect(screen.getByTestId('audit-forbidden')).toHaveTextContent(/owner access is required/i);
    expect(screen.queryByTestId('audit-table')).toBeNull();
  });
});
