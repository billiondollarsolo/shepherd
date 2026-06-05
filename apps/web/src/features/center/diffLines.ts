/**
 * Pure unified-diff classifier for the read-only Diff tab (US-33, FR-UI4).
 *
 * The orchestrator returns plain (`--no-color`) `git diff` text; the UI applies
 * its OWN semantic colouring from the flock-theme diff tokens
 * (`diff.{add,remove,context}`, spec Appendix A.3) rather than embedding ANSI.
 * This keeps "syntax-highlighted, read-only" data-driven and themeable, with no
 * extra highlighter dependency.
 *
 * A line's kind drives its colour:
 *   - `add`     → '+' content lines        (diff.add)
 *   - `remove`  → '-' content lines        (diff.remove)
 *   - `hunk`    → '@@ ... @@' hunk headers
 *   - `meta`    → file headers / index / +++ / --- lines
 *   - `context` → unchanged context lines
 */
export type DiffLineKind = 'add' | 'remove' | 'hunk' | 'meta' | 'context';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}

/** True when a diff string has no content (clean tree). */
export function isEmptyDiff(diff: string): boolean {
  return diff.trim().length === 0;
}

/** Classify a single unified-diff line. */
function classify(line: string): DiffLineKind {
  // File metadata first: `+++`/`---` must be matched BEFORE the bare `+`/`-`.
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('+++ ') ||
    line.startsWith('--- ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('rename ') ||
    line.startsWith('similarity ') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('\\ No newline')
  ) {
    return 'meta';
  }
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

/**
 * Parse unified diff text into classified lines. A trailing newline does NOT
 * produce an empty final line. An empty/whitespace-only diff yields `[]`.
 */
export function parseDiff(diff: string): DiffLine[] {
  if (isEmptyDiff(diff)) return [];
  const raw = diff.replace(/\n$/, '');
  return raw.split('\n').map((text) => ({ kind: classify(text), text }));
}
