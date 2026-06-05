/**
 * DiffTab — the center pane's READ-ONLY Diff tab (US-33, FR-UI4).
 *
 * On mount it fetches `GET /api/sessions/:id/diff` and renders the unified diff
 * as syntax-highlighted, read-only text. Colouring is data-driven from the
 * flock-theme diff tokens (`status`/`diff` CSS vars) via {@link parseDiff} — no
 * editor, no input affordances: v1 is view-only (stage/commit/PR → v1.x,
 * spec §4.2). We do NOT iframe anything; this is plain text rendered in a
 * scrollable `<pre>`-style surface.
 *
 * The fetch impl is injectable so the component is unit-testable without a real
 * network, mirroring the Terminal/BrowserPane injectable-factory convention.
 */
import { useEffect, useState } from 'react';

import { DiffApiError, fetchSessionDiff, type FetchLike } from './diffApi';
import { isEmptyDiff, parseDiff, type DiffLineKind } from './diffLines';

export interface DiffTabProps {
  /** The single authoritative session id (spec §4.2). */
  sessionId: string;
  /** Injected for tests; defaults to the real `fetchSessionDiff`/`fetch`. */
  fetchImpl?: FetchLike;
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; diff: string }
  | { phase: 'error'; message: string };

/** Tailwind text colour per diff line kind, mapped to flock-theme diff tokens. */
const LINE_CLASS: Record<DiffLineKind, string> = {
  add: 'text-diff-add',
  remove: 'text-diff-remove',
  hunk: 'text-flock-accent',
  meta: 'text-flock-muted',
  context: 'text-flock-fg',
};

export default function DiffTab({ sessionId, fetchImpl }: DiffTabProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    fetchSessionDiff(sessionId, fetchImpl)
      .then((res) => {
        if (!cancelled) setState({ phase: 'ready', diff: res.diff });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof DiffApiError
            ? err.message
            : 'Could not load the diff for this session.';
        setState({ phase: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, fetchImpl]);

  if (state.phase === 'loading') {
    return (
      <div
        data-testid="diff-loading"
        className="flex h-full w-full items-center justify-center text-sm text-flock-muted"
      >
        Loading diff…
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div
        data-testid="diff-error"
        role="alert"
        className="flex h-full w-full items-center justify-center px-4 text-center text-sm text-status-error"
      >
        {state.message}
      </div>
    );
  }

  if (isEmptyDiff(state.diff)) {
    return (
      <div
        data-testid="diff-empty"
        className="flex h-full w-full items-center justify-center text-sm text-flock-muted"
      >
        No changes in the working directory.
      </div>
    );
  }

  const lines = parseDiff(state.diff);
  return (
    <div
      data-testid="diff-view"
      // Read-only by design (US-33): a scrollable, non-editable code surface.
      aria-readonly="true"
      className="h-full w-full overflow-auto bg-flock-bg font-mono text-xs leading-relaxed"
    >
      <pre className="m-0 min-w-full p-3">
        <code>
          {lines.map((line, i) => (
            <div
              // Diff lines are positional and not reorderable; index key is fine.
              key={i}
              data-diff-kind={line.kind}
              className={`whitespace-pre ${LINE_CLASS[line.kind]}`}
            >
              {line.text === '' ? ' ' : line.text}
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}
