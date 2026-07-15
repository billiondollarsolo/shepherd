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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import DiffTab from './DiffTab';

const HERE = dirname(fileURLToPath(import.meta.url));

// Unmount + clear the jsdom document between tests so rendered diff nodes do not
// leak across this file OR into later test files (no global auto-cleanup).
afterEach(() => cleanup());

// The shared DiffResponse contract validates `sessionId` as a UUID, so the
// fixtures use a real uuid (not a placeholder like "sess-abc").
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? status : status,
    headers: { 'content-type': 'application/json' },
  });
}

const SAMPLE_DIFF = ['diff --git a/x b/x', '@@ -1 +1 @@', '-old', '+new'].join('\n');

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
    expect(fetchImpl.mock.calls[0]![0] as string).toContain(`/api/sessions/${SESSION_ID}/diff`);

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

/**
 * Regression guard for the "monochrome diff" bug: the add/remove rows MUST carry
 * the real, resolving diff tokens. The class name is only half the chain — this
 * also verifies the tailwind binding and the per-theme CSS var exist, so a class
 * can never silently no-op (resolve to nothing) again the way `text-diff-add`
 * did before Phase 1.
 */
describe('DiffTab diff-token wiring (Phase 4.1)', () => {
  it('renders add/remove rows with line-tint + saturated-foreground tokens', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        sessionId: SESSION_ID,
        diff: SAMPLE_DIFF,
        generatedAt: '2026-05-29T01:00:00.000Z',
      }),
    );

    render(<DiffTab sessionId={SESSION_ID} fetchImpl={fetchImpl as unknown as typeof fetch} />);
    const view = await screen.findByTestId('diff-view');

    const addRow = view.querySelector('[data-diff-kind="add"]')!;
    expect(addRow.className).toContain('bg-flock-diff-add');
    expect(addRow.className).toContain('text-flock-diff-add-fg');

    const removeRow = view.querySelector('[data-diff-kind="remove"]')!;
    expect(removeRow.className).toContain('bg-flock-diff-remove');
    expect(removeRow.className).toContain('text-flock-diff-remove-fg');

    // Hunk headers keep the accent (no tint).
    expect(view.querySelector('[data-diff-kind="hunk"]')!.className).toContain('text-flock-accent');
  });

  it('binds those diff classes to real CSS variables in the tailwind config', () => {
    const twConfig = readFileSync(resolve(HERE, '../../../tailwind.config.cjs'), 'utf8');
    // bg-flock-diff-add / bg-flock-diff-remove come from the `colors` map…
    expect(twConfig).toContain("'flock-diff-add': 'var(--flock-diff-add)'");
    expect(twConfig).toContain("'flock-diff-remove': 'var(--flock-diff-remove)'");
    // …and text-flock-diff-add-fg / -remove-fg from the *-fg entries.
    expect(twConfig).toContain("'flock-diff-add-fg': 'var(--flock-diff-add-fg)'");
    expect(twConfig).toContain("'flock-diff-remove-fg': 'var(--flock-diff-remove-fg)'");
  });

  it('defines each diff variable with a real value in BOTH themes', () => {
    const themeCss = readFileSync(resolve(HERE, '../../styles/theme.css'), 'utf8');
    for (const name of [
      '--flock-diff-add',
      '--flock-diff-remove',
      '--flock-diff-add-fg',
      '--flock-diff-remove-fg',
    ]) {
      // A definition must exist for BOTH the light root and the dark override
      // (each var appears in the light `:root` and again under dark), and every
      // occurrence must assign a non-empty value — an empty var re-introduces the
      // no-op the tokens are meant to prevent.
      const decls = [...themeCss.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))];
      expect(decls.length).toBeGreaterThanOrEqual(2);
      for (const d of decls) expect(d[1]!.trim().length).toBeGreaterThan(0);
    }
  });
});
