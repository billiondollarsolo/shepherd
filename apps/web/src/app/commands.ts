/**
 * Command palette command model (US-30, Appendix A.2).
 *
 * A `Command` is a titled, runnable action surfaced by the Cmd+K palette. The
 * registry is intentionally tiny and data-driven so later UI stories (themes,
 * session actions, node management) register their own commands without touching
 * the palette component.
 */
export interface Command {
  /** Stable id (used as React key and for analytics/keybinding lookup). */
  readonly id: string;
  /** Human-readable label shown in the palette. */
  readonly title: string;
  /** Optional secondary text / category shown muted on the right. */
  readonly hint?: string;
  /** Optional keyboard shortcut label, e.g. "⌘J". */
  readonly shortcut?: string;
  /** Invoked when the command is chosen. */
  run: () => void;
}

/** Case-insensitive substring match over title + hint. */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...commands];
  return commands.filter((c) => `${c.title} ${c.hint ?? ''}`.toLowerCase().includes(q));
}
