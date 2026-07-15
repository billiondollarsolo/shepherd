import { describe, expect, it, vi } from 'vitest';
import {
  fuzzyMatch,
  scoreCommand,
  searchCommands,
  filterCommands,
  pushRecent,
  recentCommands,
  shortcutLabel,
  SHORTCUTS,
  type Command,
} from './commands';

function cmd(id: string, title: string, hint?: string): Command {
  return { id, title, hint, run: vi.fn() };
}

describe('fuzzyMatch (pure scorer)', () => {
  it('matches non-contiguous subsequences and returns ascending indices', () => {
    const m = fuzzyMatch('Toggle shell drawer', 'tsd');
    expect(m).not.toBeNull();
    expect(m!.indices).toEqual([0, 7, 13]); // T(oggle) s(hell) d(rawer)
    // indices strictly ascending
    expect([...m!.indices]).toEqual([...m!.indices].sort((a, b) => a - b));
  });

  it('is case-insensitive', () => {
    expect(fuzzyMatch('Open Settings', 'OPEN')).not.toBeNull();
    expect(fuzzyMatch('open settings', 'SET')).not.toBeNull();
  });

  it('returns null when a query char is absent or out of order', () => {
    expect(fuzzyMatch('Toggle theme', 'drawer')).toBeNull();
    expect(fuzzyMatch('abc', 'ca')).toBeNull(); // order matters
  });

  it('treats an empty / whitespace query as a trivial (zero-score) match', () => {
    expect(fuzzyMatch('anything', '')).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch('anything', '   ')).toEqual({ score: 0, indices: [] });
  });

  it('ignores spaces in the query (word-separated terms)', () => {
    const m = fuzzyMatch('Open Source Control', 'op co');
    expect(m).not.toBeNull();
  });

  it('scores a contiguous prefix match higher than a scattered one', () => {
    const prefix = fuzzyMatch('settings panel', 'set')!;
    const scattered = fuzzyMatch('subtle test', 'set')!;
    expect(prefix.score).toBeGreaterThan(scattered.score);
  });

  it('rewards word-boundary matches over mid-word ones', () => {
    const boundary = fuzzyMatch('open source', 'os')!; // o(pen) s(ource)
    const midword = fuzzyMatch('gnomosaur', 'os')!;
    expect(boundary.score).toBeGreaterThan(midword.score);
  });
});

describe('scoreCommand', () => {
  it('prefers a title match (with indices) over a hint-only match', () => {
    const titled = scoreCommand(cmd('a', 'Settings', 'Go'), 'sett');
    expect(titled).not.toBeNull();
    expect(titled!.indices.length).toBeGreaterThan(0);
  });

  it('falls back to the hint with no title indices', () => {
    const hinted = scoreCommand(cmd('b', 'Paddock', 'Navigate'), 'nav');
    expect(hinted).not.toBeNull();
    expect(hinted!.indices).toEqual([]);
  });

  it('returns null when neither title nor hint match', () => {
    expect(scoreCommand(cmd('c', 'Paddock', 'Go'), 'zzz')).toBeNull();
  });
});

describe('searchCommands', () => {
  const cmds = [
    cmd('1', 'Toggle shell drawer'),
    cmd('2', 'Toggle theme'),
    cmd('3', 'Open settings'),
  ];

  it('returns every command (registration order) for an empty query', () => {
    expect(searchCommands(cmds, '').map((s) => s.command.id)).toEqual(['1', '2', '3']);
  });

  it('filters to fuzzy matches only', () => {
    const ids = searchCommands(cmds, 'drawer').map((s) => s.command.id);
    expect(ids).toEqual(['1']);
  });

  it('keeps registration order for equal-strength matches (stable sort)', () => {
    // Same prefix "Toggle", identical title length → a true score tie; the
    // stable sort must preserve original registration order.
    const tie = [cmd('x', 'Toggle alpha'), cmd('y', 'Toggle bravo')];
    expect(searchCommands(tie, 'toggle').map((s) => s.command.id)).toEqual(['x', 'y']);
  });

  it('ranks a tighter/shorter match above a looser one', () => {
    const ids = searchCommands(cmds, 'toggle').map((s) => s.command.id);
    expect(ids).toEqual(['2', '1']); // "Toggle theme" (shorter) outranks "Toggle shell drawer"
  });

  it('filterCommands is a thin wrapper returning bare commands', () => {
    expect(filterCommands(cmds, 'settings').map((c) => c.id)).toEqual(['3']);
  });
});

describe('MRU helpers (pure)', () => {
  it('pushRecent moves an id to the front and de-dupes', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(pushRecent(['a', 'b'], 'x')).toEqual(['x', 'a', 'b']);
  });

  it('pushRecent caps the list at the limit', () => {
    expect(pushRecent(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
  });

  it('pushRecent does not mutate its input', () => {
    const input = ['a', 'b'];
    pushRecent(input, 'c');
    expect(input).toEqual(['a', 'b']);
  });

  it('recentCommands resolves ids in MRU order, dropping unknown ids', () => {
    const cmds = [cmd('a', 'A'), cmd('b', 'B'), cmd('c', 'C')];
    expect(recentCommands(cmds, ['c', 'gone', 'a']).map((c) => c.id)).toEqual(['c', 'a']);
  });
});

describe('shortcut registry', () => {
  it('shortcutLabel flattens key glyphs', () => {
    expect(shortcutLabel('command-palette')).toBe('⌘K');
    expect(shortcutLabel('shell-drawer')).toBe('⌘J');
    expect(shortcutLabel('shortcuts')).toBe('?');
  });

  it('returns an empty string for an unknown id', () => {
    expect(shortcutLabel('nope')).toBe('');
  });

  it('every shortcut has an id, at least one key, and a label', () => {
    for (const s of SHORTCUTS) {
      expect(s.id).toBeTruthy();
      expect(s.keys.length).toBeGreaterThan(0);
      expect(s.label).toBeTruthy();
    }
  });
});
