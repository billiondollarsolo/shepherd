/**
 * Command palette (US-30, Codex Appendix A.2 — Cmd+K).
 *
 * A calm, centered overlay with a single search box and a filtered list of
 * commands. Keyboard-first: type to filter, Up/Down to move, Enter to run,
 * Escape to dismiss. Opening/closing and the global Cmd+K binding are owned by
 * KeyboardProvider; this component is a controlled presentation of `open`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { filterCommands, type Command } from './commands';

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly commands: readonly Command[];
  readonly onClose: () => void;
}

export function CommandPalette({
  open,
  commands,
  onClose,
}: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  // Reset transient state each time the palette opens and focus the search box.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // Focus after paint so the input exists.
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  // Keep the active index in range as results shrink/grow.
  useEffect(() => {
    setActive((i) => (results.length === 0 ? 0 : Math.min(i, results.length - 1)));
  }, [results.length]);

  if (!open) return null;

  function runAt(index: number): void {
    const cmd = results[index];
    if (!cmd) return;
    cmd.run();
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(active);
    }
    // Escape is handled globally by KeyboardProvider.
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]"
      onMouseDown={onClose}
      data-testid="command-palette-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-[36rem] max-w-[90vw] overflow-hidden rounded-lg border border-flock-muted/30 bg-flock-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-label="Search commands"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full border-b border-flock-muted/20 bg-transparent px-4 py-3 text-sm text-flock-fg outline-none placeholder:text-flock-muted"
        />
        <ul id="command-palette-list" role="listbox" className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 ? (
            <li className="px-4 py-3 text-sm text-flock-muted">No matching commands</li>
          ) : (
            results.map((cmd, i) => (
              <li key={cmd.id} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => runAt(i)}
                  className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm ${
                    i === active ? 'bg-flock-accent/15 text-flock-fg' : 'text-flock-fg/90'
                  }`}
                >
                  <span>{cmd.title}</span>
                  {cmd.shortcut ? (
                    <kbd className="text-flock-muted text-xs">{cmd.shortcut}</kbd>
                  ) : cmd.hint ? (
                    <span className="text-flock-muted text-xs">{cmd.hint}</span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
