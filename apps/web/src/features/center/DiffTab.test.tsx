/**
 * US-33 — DiffTab tests (run under `pnpm test:unit`, jsdom + RTL).
 *
 * Verifies the read-only Diff tab:
 *   - fetches GET /api/sessions/:id/diff via the injected fetch and renders the
 *     classified diff lines (add/remove/hunk/meta/context) read-only;
 *   - shows a "no changes" state for a clean tree (empty diff);
 *   - surfaces an error state on a non-2xx response;
 *   - includes the session id in the requested URL.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import DiffTab from './DiffTab';

// Unmount + clear the jsdom document between tests so rendered diff nodes do not
// leak across this file OR into later test files (no global auto-cleanup).
afterEach(() => cleanup());

// The shared DiffResponse contract validates `sessionId` as a UUID, so the
// fixtures use a real uuid (not a placeholder like "sess-abc").
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

const SAMPLE_DIFF = [
  'diff --git a/x b/x',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n');

describe('DiffTab (US-33)', () => {
  it('fetches the diff for the session and renders it read-only', async () => {
    const fetchImpl = vi.fn(async (_url: string) =>
      jsonResponse({
        sessionId: SESSION_ID,
        diff: SAMPLE_DIFF,
        generatedAt: '2026-05-29T01:00:00.000Z',
      }),
    );

    render(<DiffTab sessionId={SESSION_ID} fetchImpl={fetchImpl as unknown as typeof fetch} />);

    const view = await screen.findByTestId('diff-view');
    expect(view).toHaveAttribute('aria-readonly', 'true');

    // The request targeted the session-scoped diff endpoint.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0]![0] as string)).toContain(
      `/api/sessions/${SESSION_ID}/diff`,
    );

    // Lines are classified for theme-driven colouring.
    expect(view.querySelector('[data-diff-kind="add"]')).toHaveTextContent('+new');
    expect(view.querySelector('[data-diff-kind="remove"]')).toHaveTextContent('-old');
    expect(view.querySelector('[data-diff-kind="hunk"]')).toBeTruthy();
  });

  it('shows a "no changes" state for a clean tree', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        sessionId: SESSION_ID,
        diff: '',
        generatedAt: '2026-05-29T01:00:00.000Z',
      }),
    );

    render(<DiffTab sessionId={SESSION_ID} fetchImpl={fetchImpl as unknown as typeof fetch} />);

    expect(await screen.findByTestId('diff-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('diff-view')).toBeNull();
  });

  it('shows an error state on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { code: 'diff_unavailable', message: 'not a git repository' } },
        false,
        422,
      ),
    );

    render(<DiffTab sessionId={SESSION_ID} fetchImpl={fetchImpl as unknown as typeof fetch} />);

    const err = await screen.findByTestId('diff-error');
    expect(err).toHaveTextContent('not a git repository');
  });
});
