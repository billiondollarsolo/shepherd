/**
 * Command palette command model + shortcut registry (US-30, Appendix A.2).
 *
 * A `Command` is a titled, runnable action surfaced by the Cmd+K palette. The
 * registry is intentionally tiny and data-driven so later UI stories (themes,
 * session actions, node management) register their own commands without touching
 * the palette component.
 *
 * This module also owns the SINGLE keyboard-shortcut registry ({@link SHORTCUTS})
 * so the palette's shortcut labels, the SessionPane hints, and the global `?`
 * cheatsheet all read from one place and never drift.
 */
import type { ComponentType } from 'react';

export interface Command {
  /** Stable id (used as React key and for analytics/keybinding lookup). */
  readonly id: string;
  /** Human-readable label shown in the palette. */
  readonly title: string;
  /** Optional secondary text / category shown muted on the right. */
  readonly hint?: string;
  /** Optional keyboard shortcut label, e.g. "⌘J". */
  readonly shortcut?: string;
  /** Optional leading icon (lucide-compatible; sized by the palette). */
  readonly icon?: ComponentType<{ className?: string }>;
  /** Invoked when the command is chosen. */
  run: () => void;
}

/* ------------------------------------------------------------------ *
 * Fuzzy subsequence scorer (pure)
 * ------------------------------------------------------------------ */

/** A scored fuzzy match: a ranking `score` and the matched char `indices`. */
export interface FuzzyMatch {
  readonly score: number;
  /** Indices in the source string that the query matched, ascending. */
  readonly indices: readonly number[];
}

/** Chars that begin a "word" — a match right after one earns a boundary bonus. */
const BOUNDARY_CHARS = new Set([' ', '·', '-', '_', ':', '/', '.', '(', '[']);

/**
 * Case-insensitive fuzzy subsequence match. Returns `null` when not every
 * (non-space) query char appears in order within `text`; otherwise a ranking
 * score plus the matched indices (for highlighting). Pure + deterministic.
 *
 * Scoring rewards: matches at the string start, matches on word boundaries, and
 * runs of consecutive matches; it penalizes gaps and leftover length so tighter,
 * earlier, boundary-aligned matches rank first.
 */
export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (q === '') return { score: 0, indices: [] };

  const lower = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let cursor = 0;
  let prev = -2; // index of the previously matched char (-2 → non-adjacent)

  for (const ch of q) {
    if (ch === ' ') continue; // spaces are separators, not literal matches
    let found = -1;
    for (let t = cursor; t < lower.length; t++) {
      if (lower[t] === ch) {
        found = t;
        break;
      }
    }
    if (found === -1) return null;

    let bonus = 1;
    if (found === 0) bonus += 12;
    else if (BOUNDARY_CHARS.has(lower[found - 1]!)) bonus += 10;
    if (found === prev + 1) bonus += 8; // consecutive run
    bonus -= Math.min(found - (prev + 1), 3); // gap penalty (capped)

    score += bonus;
    indices.push(found);
    prev = found;
    cursor = found + 1;
  }

  // Prefer shorter, tighter matches (less unmatched leftover).
  score -= (text.length - indices.length) * 0.05;
  return { score, indices };
}

/** A command paired with its fuzzy score + matched title indices. */
export interface ScoredCommand {
  readonly command: Command;
  readonly score: number;
  /** Matched indices in `command.title` (empty when matched via hint only). */
  readonly indices: readonly number[];
}

/**
 * Score a single command against a query. Matches the title first (indices power
 * the highlight); falls back to the hint at a lower score with no title indices.
 */
export function scoreCommand(command: Command, query: string): ScoredCommand | null {
  const title = fuzzyMatch(command.title, query);
  if (title) return { command, score: title.score + 5, indices: title.indices };
  if (command.hint) {
    const hint = fuzzyMatch(command.hint, query);
    if (hint) return { command, score: hint.score, indices: [] };
  }
  return null;
}

/**
 * Rank commands against a query, best first. An empty query returns every
 * command in registration order (score 0, no highlight). The sort is stable:
 * ties preserve original order.
 */
export function searchCommands(commands: readonly Command[], query: string): ScoredCommand[] {
  if (query.trim() === '') {
    return commands.map((command) => ({ command, score: 0, indices: [] }));
  }
  const scored: Array<{ result: ScoredCommand; order: number }> = [];
  commands.forEach((command, order) => {
    const result = scoreCommand(command, query);
    if (result) scored.push({ result, order });
  });
  scored.sort((a, b) => b.result.score - a.result.score || a.order - b.order);
  return scored.map((s) => s.result);
}

/** Case-insensitive fuzzy filter (thin wrapper; kept for callers wanting bare Commands). */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  return searchCommands(commands, query).map((s) => s.command);
}

/* ------------------------------------------------------------------ *
 * MRU ("Recent") — pure helpers
 * ------------------------------------------------------------------ */

/** Default cap on the recent-commands list. */
export const MRU_LIMIT = 6;

/**
 * Record `id` as most-recently-used: move it to the front, de-dupe, and cap the
 * list at `limit`. Pure — returns a new array, never mutates the input.
 */
export function pushRecent(
  recent: readonly string[],
  id: string,
  limit: number = MRU_LIMIT,
): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, limit);
}

/**
 * Resolve a recent-id list back to live commands, preserving MRU order and
 * dropping ids that no longer exist in the registry.
 */
export function recentCommands(commands: readonly Command[], recent: readonly string[]): Command[] {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const out: Command[] = [];
  for (const id of recent) {
    const c = byId.get(id);
    if (c) out.push(c);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Shortcut registry (single source of truth — 6.3)
 * ------------------------------------------------------------------ */

/** One global keyboard shortcut: an id, its key glyphs, and a human label. */
export interface Shortcut {
  /** Stable id for label lookup (e.g. 'command-palette'). */
  readonly id: string;
  /** Key glyphs rendered as separate <Kbd> chips, e.g. ['⌘', 'K']. */
  readonly keys: readonly string[];
  /** Human-readable description shown in the cheatsheet. */
  readonly label: string;
}

/**
 * The one keyboard-shortcut registry. Palette shortcut labels, the SessionPane
 * hints, and the global `?` cheatsheet all read from here so they never drift.
 */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'command-palette', keys: ['⌘', 'K'], label: 'Open the command palette' },
  { id: 'shell-drawer', keys: ['⌘', 'J'], label: 'Toggle the shell drawer' },
  { id: 'shortcuts', keys: ['?'], label: 'Show keyboard shortcuts' },
  { id: 'palette-nav', keys: ['↑', '↓'], label: 'Move between results' },
  { id: 'palette-run', keys: ['↵'], label: 'Run the selected command' },
  { id: 'dismiss', keys: ['Esc'], label: 'Close the palette or overlay' },
];

/**
 * Flattened display label for a shortcut, e.g. `shortcutLabel('command-palette')`
 * → `'⌘K'`. Returns '' for an unknown id so callers can render nothing safely.
 */
export function shortcutLabel(id: string): string {
  const s = SHORTCUTS.find((x) => x.id === id);
  return s ? s.keys.join('') : '';
}
