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
 * network, mirroring the Terminal injectable-factory convention.
 */
import { useEffect, useState } from 'react';

import { fetchSessionDiff, type FetchLike } from './diffApi';
import { ApiError } from '../../lib/apiClient';
import { isEmptyDiff, parseDiff, type DiffLine, type DiffLineKind } from './diffLines';

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

/**
 * Per-line-kind Tailwind classes, mapped to the flock-theme diff tokens.
 *
 * add/remove get a LINE-LEVEL background tint (`bg-flock-diff-*`) plus the
 * saturated, AA foreground (`text-flock-diff-*-fg`) — these resolve to real CSS
 * vars in both themes (see the token test), so the diff can never silently fall
 * back to monochrome again. hunk headers keep the accent; meta/context stay
 * quiet. Note: the earlier `text-diff-add`/`text-diff-remove` spelling only
 * carried a foreground and resolved to nothing before Phase 1, which is why the
 * whole surface read grey.
 */
const ROW_CLASS: Record<DiffLineKind, string> = {
  add: 'bg-flock-diff-add text-flock-diff-add-fg',
  remove: 'bg-flock-diff-remove text-flock-diff-remove-fg',
  hunk: 'text-flock-accent',
  meta: 'text-flock-muted',
  context: 'text-flock-fg',
};

/** A diff line resolved into gutter numbers + a stripped sign for rendering. */
interface DiffRow {
  readonly kind: DiffLineKind;
  /** '+', '-', ' ' for content lines; '' for hunk/meta rows (no gutter). */
  readonly sign: string;
  /** Line body with the leading +/-/space stripped (raw text for hunk/meta). */
  readonly content: string;
  /** Old-file (pre-image) line number, or null. */
  readonly oldNo: number | null;
  /** New-file (post-image) line number, or null. */
  readonly newNo: number | null;
}

/** `@@ -oldStart[,n] +newStart[,n] @@` — captures the two 1-based line origins. */
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Resolve classified diff lines into rows carrying old/new line numbers, walking
 * the hunk headers to keep the two counters in sync (adds advance only the new
 * side, removes only the old side, context both). Pure — safe to memoize/share.
 */
export function toDiffRows(lines: readonly DiffLine[]): DiffRow[] {
  let oldNo = 0;
  let newNo = 0;
  return lines.map((line): DiffRow => {
    switch (line.kind) {
      case 'hunk': {
        const m = HUNK_RE.exec(line.text);
        if (m) {
          oldNo = Number(m[1]);
          newNo = Number(m[2]);
        }
        return { kind: line.kind, sign: '', content: line.text, oldNo: null, newNo: null };
      }
      case 'meta':
        return { kind: line.kind, sign: '', content: line.text, oldNo: null, newNo: null };
      case 'add': {
        const row = { kind: line.kind, sign: '+', content: line.text.slice(1), oldNo: null, newNo };
        newNo += 1;
        return row;
      }
      case 'remove': {
        const row = { kind: line.kind, sign: '-', content: line.text.slice(1), oldNo, newNo: null };
        oldNo += 1;
        return row;
      }
      default: {
        const row = { kind: line.kind, sign: ' ', content: line.text.slice(1), oldNo, newNo };
        oldNo += 1;
        newNo += 1;
        return row;
      }
    }
  });
}

/**
 * The shared, read-only diff renderer: a fixed-width old/new line-number gutter,
 * a sign column, and a line-tinted body. Reused by the Diff tab and the Source
 * Control per-file preview so both surfaces stay pixel-identical. Callers own the
 * scroll container; this block grows to its widest line (`w-max`) so long lines
 * scroll horizontally while short rows still paint their tint full-width.
 */
export function DiffBody({ lines }: { lines: readonly DiffLine[] }): JSX.Element {
  const rows = toDiffRows(lines);
  return (
    <div className="w-max min-w-full font-mono text-xs leading-relaxed">
      {rows.map((row, i) => (
        <div
          // Diff lines are positional and not reorderable; index key is fine.
          key={i}
          data-diff-kind={row.kind}
          className={`flex min-w-full ${ROW_CLASS[row.kind]}`}
        >
          <span className="w-10 shrink-0 select-none px-2 text-right tabular-nums text-flock-ink-muted">
            {row.oldNo ?? ''}
          </span>
          <span className="w-10 shrink-0 select-none pr-2 text-right tabular-nums text-flock-ink-muted">
            {row.newNo ?? ''}
          </span>
          <span className="w-4 shrink-0 select-none text-center" aria-hidden>
            {row.sign}
          </span>
          <span className="whitespace-pre pr-3">{row.content === '' ? ' ' : row.content}</span>
        </div>
      ))}
    </div>
  );
}

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
          err instanceof ApiError ? err.message : 'Could not load the diff for this session.';
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
        className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-flock-muted"
      >
        <p>No tracked changes in the working directory.</p>
        <p className="max-w-sm text-2xs text-flock-ink-muted">
          Untracked files appear under Source Control. Use a git project with at least one commit so
          agent edits show up as a real diff.
        </p>
      </div>
    );
  }

  const lines = parseDiff(state.diff);
  return (
    <div
      data-testid="diff-view"
      // Read-only by design (US-33): a scrollable, non-editable code surface.
      aria-readonly="true"
      className="h-full w-full overflow-auto bg-flock-bg py-3"
    >
      <DiffBody lines={lines} />
    </div>
  );
}
