/**
 * US-33.1 — SourceControlPanel tests.
 *
 * Drives the panel against a stubbed `fetch` (routing by URL) inside a real
 * QueryClient, asserting the Codex review loop: the file list splits into
 * Staged / Changes, staging a file POSTs to `/git/stage`, committing POSTs to
 * `/git/commit`, and clicking a file opens its scoped diff preview.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import SourceControlPanel from './SourceControlPanel';
import { usePaddock } from '../../store/paddock';

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const STATUS = {
  sessionId: SESSION_ID,
  branch: 'main',
  upstream: 'origin/main',
  ahead: 2,
  behind: 0,
  hasHead: true,
  files: [
    {
      path: 'src/staged.ts',
      origPath: null,
      indexStatus: 'M',
      worktreeStatus: '.',
      staged: true,
      unstaged: false,
      kind: 'modified',
    },
    {
      path: 'src/changed.ts',
      origPath: null,
      indexStatus: '.',
      worktreeStatus: 'M',
      staged: false,
      unstaged: true,
      kind: 'modified',
    },
  ],
  generatedAt: '2026-06-02T00:00:00.000Z',
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const calls: Array<{ url: string; method: string; body?: string }> = [];

beforeEach(() => {
  calls.length = 0;
  usePaddock.setState({ diffSelectedPath: null, diffSelectedStaged: null });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push({ url: u, method, body: init?.body as string | undefined });
      if (u.includes('/git/status')) return json(STATUS);
      if (u.includes('/git/stage') || u.includes('/git/unstage')) return json(STATUS);
      if (u.includes('/git/commit')) {
        return json({
          sessionId: SESSION_ID,
          committed: true,
          sha: 'abc123',
          detail: 'done',
          generatedAt: STATUS.generatedAt,
        });
      }
      if (u.includes('/diff')) {
        return json({
          sessionId: SESSION_ID,
          diff: 'diff --git a/src/staged.ts b/src/staged.ts\n@@ -1 +1 @@\n-old\n+new\n',
          generatedAt: STATUS.generatedAt,
        });
      }
      return json({});
    }),
  );
});

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SourceControlPanel sessionId={SESSION_ID} />
    </QueryClientProvider>,
  );
}

describe('SourceControlPanel (US-33.1)', () => {
  it('renders the branch and splits files into Staged / Changes', async () => {
    renderPanel();
    expect(await screen.findByTestId('sc-branch')).toHaveTextContent('main');
    const staged = await screen.findByTestId('sc-staged');
    const changes = await screen.findByTestId('sc-changes');
    expect(staged).toHaveTextContent('src/staged.ts');
    expect(changes).toHaveTextContent('src/changed.ts');
  });

  it('stages a changed file via POST /git/stage', async () => {
    renderPanel();
    const stageBtn = await screen.findByLabelText('Stage src/changed.ts');
    fireEvent.click(stageBtn);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/git/stage') && c.method === 'POST')).toBe(true);
    });
    const stage = calls.find((c) => c.url.includes('/git/stage'));
    expect(stage?.body).toContain('src/changed.ts');
  });

  it('disables Commit until there is a message, then POSTs /git/commit', async () => {
    renderPanel();
    const commit = (await screen.findByTestId('sc-commit')) as HTMLButtonElement;
    expect(commit.disabled).toBe(true); // staged exists but no message yet

    fireEvent.change(screen.getByTestId('sc-message'), { target: { value: 'my commit' } });
    expect(commit.disabled).toBe(false);

    fireEvent.click(commit);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/git/commit') && c.method === 'POST')).toBe(true);
    });
    expect(calls.find((c) => c.url.includes('/git/commit'))?.body).toContain('my commit');
  });

  it('opens a per-file diff preview on click (scoped fetch)', async () => {
    renderPanel();
    const fileBtn = await screen.findByRole('button', { name: 'src/staged.ts' });
    fireEvent.click(fileBtn);
    expect(await screen.findByTestId('sc-preview')).toBeInTheDocument();
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/diff') && c.url.includes('path='))).toBe(true);
    });
  });

  it('pushes via POST /git/push', async () => {
    renderPanel();
    const push = await screen.findByTestId('sc-push');
    fireEvent.click(push);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/git/push') && c.method === 'POST')).toBe(true);
    });
  });
});
