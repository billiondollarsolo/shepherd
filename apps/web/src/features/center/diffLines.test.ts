/**
 * US-33 — diffLines unit tests (pure logic, `pnpm test:unit`).
 * Pins the unified-diff classification that drives the read-only Diff tab's
 * theme-token colouring.
 */
import { describe, expect, it } from 'vitest';

import { isEmptyDiff, parseDiff, type DiffLine } from './diffLines';

const SAMPLE = [
  'diff --git a/src/x.ts b/src/x.ts',
  'index 1111111..2222222 100644',
  '--- a/src/x.ts',
  '+++ b/src/x.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' const c = 4;',
].join('\n');

function kinds(lines: DiffLine[]): string[] {
  return lines.map((l) => l.kind);
}

describe('isEmptyDiff', () => {
  it('treats empty / whitespace-only diffs as empty', () => {
    expect(isEmptyDiff('')).toBe(true);
    expect(isEmptyDiff('   \n  ')).toBe(true);
  });
  it('treats real diff text as non-empty', () => {
    expect(isEmptyDiff(SAMPLE)).toBe(false);
  });
});

describe('parseDiff', () => {
  it('returns [] for a clean (empty) tree', () => {
    expect(parseDiff('')).toEqual([]);
  });

  it('classifies meta, hunk, add, remove, and context lines', () => {
    const lines = parseDiff(SAMPLE);
    expect(kinds(lines)).toEqual([
      'meta', // diff --git
      'meta', // index
      'meta', // ---
      'meta', // +++
      'hunk', // @@
      'context',
      'remove',
      'add',
      'context',
    ]);
  });

  it('does not emit a trailing empty line for a trailing newline', () => {
    const lines = parseDiff('+added\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ kind: 'add', text: '+added' });
  });
});
