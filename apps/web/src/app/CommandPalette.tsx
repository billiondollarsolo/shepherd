/**
 * Command palette (US-30, Codex Appendix A.2 — Cmd+K).
 *
 * A calm, centered overlay with a single search box and a fuzzy-ranked list of
 * commands, grouped by category with uppercase section headers. Keyboard-first:
 * type to fuzzy-filter, Up/Down to move (FLAT across groups), Enter to run,
 * Escape to dismiss. Opening/closing and the global Cmd+K binding are owned by
 * KeyboardProvider; this component is a controlled presentation of `open`.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  pushRecent,
  recentCommands,
  searchCommands,
  type Command,
  type ScoredCommand,
} from './commands';

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly commands: readonly Command[];
  readonly onClose: () => void;
}

const RECENT_KEY = 'flock.commandPalette.recent';

/** One rendered section: an uppercase header + its ordered scored items. */
interface Group {
  readonly label: string;
  readonly items: readonly ScoredCommand[];
}

/** Group scored results by their hint category, preserving encounter order. */
function groupByCategory(items: readonly ScoredCommand[]): Group[] {
  const map = new Map<string, ScoredCommand[]>();
  for (const it of items) {
    const key = it.command.hint ?? 'Commands';
    const arr = map.get(key);
    if (arr) arr.push(it);
    else map.set(key, [it]);
  }
  return [...map.entries()].map(([label, groupItems]) => ({ label, items: groupItems }));
}

/** Wrap plain commands as zero-score scored entries (empty-query / recent). */
function asScored(commands: readonly Command[]): ScoredCommand[] {
  return commands.map((command) => ({ command, score: 0, indices: [] }));
}

/** Read persisted MRU ids (device-local; tolerant of denied/absent storage). */
function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Highlight the fuzzy-matched chars of a title (mirrors SearchPanel's <mark>). */
function Highlight({ text, indices }: { text: string; indices: readonly number[] }): ReactNode {
  if (indices.length === 0) return text;
  const marked = new Set(indices);
  const out: ReactNode[] = [];
  let segment = '';
  let segMarked = marked.has(0);
  let key = 0;
  const flush = (): void => {
    if (segment === '') return;
    out.push(
      segMarked ? (
        <mark key={key++} className="rounded-sm bg-flock-accent/30 text-flock-ink-primary">
          {segment}
        </mark>
      ) : (
        <span key={key++}>{segment}</span>
      ),
    );
    segment = '';
  };
  for (let i = 0; i < text.length; i++) {
    const isMarked = marked.has(i);
    if (isMarked !== segMarked) {
      flush();
      segMarked = isMarked;
    }
    segment += text[i];
  }
  flush();
  return out;
}

export function CommandPalette({
  open,
  commands,
  onClose,
}: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<readonly string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Build the display groups (visual sections) and a FLAT ordered list that
  // arrow-nav / Enter index into, so navigation never notices the grouping.
  const { groups, flat } = useMemo(() => {
    const trimmed = query.trim();
    let built: Group[];
    if (trimmed === '') {
      const recentCmds = recentCommands(commands, recent);
      const recentIds = new Set(recentCmds.map((c) => c.id));
      const rest = commands.filter((c) => !recentIds.has(c.id));
      built = [
        ...(recentCmds.length > 0 ? [{ label: 'Recent', items: asScored(recentCmds) }] : []),
        ...groupByCategory(asScored(rest)),
      ];
    } else {
      built = groupByCategory(searchCommands(commands, trimmed));
    }
    return { groups: built, flat: built.flatMap((g) => g.items) };
  }, [commands, query, recent]);

  // Reset transient state each time the palette opens; hydrate MRU + focus input.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      setRecent(readRecent());
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  // Keep the active index in range as results shrink/grow.
  useEffect(() => {
    setActive((i) => (flat.length === 0 ? 0 : Math.min(i, flat.length - 1)));
  }, [flat.length]);

  // Scroll the active option into view as the selection moves (block:'nearest'
  // never yanks the whole page — only the palette list scrolls).
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  function runAt(index: number): void {
    const entry = flat[index];
    if (!entry) return;
    const next = pushRecent(recent, entry.command.id);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // MRU persistence is best-effort (private mode / denied storage).
    }
    entry.command.run();
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (flat.length === 0 ? 0 : (i + 1) % flat.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (flat.length === 0 ? 0 : (i - 1 + flat.length) % flat.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(active);
    } else if (e.key === 'Tab') {
      // The palette has one intentional keyboard focus target; results are
      // selected with arrows/Enter. Keep focus inside the modal.
      e.preventDefault();
      inputRef.current?.focus();
    }
    // Escape is handled globally by KeyboardProvider.
  }

  const activeId = flat[active] ? `command-option-${active}` : undefined;
  let flatIndex = -1;

  return (
    <div
      className="animate-scrim-in fixed inset-0 z-50 flex items-start justify-center bg-flock-scrim pt-[12vh] backdrop-blur-scrim"
      onMouseDown={onClose}
      data-testid="command-palette-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="animate-palette-in w-[36rem] max-w-[90vw] overflow-hidden rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 shadow-overlay"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={activeId}
          aria-label="Search commands"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full border-b border-[var(--flock-border)] bg-transparent px-4 py-3 text-sm text-flock-ink-primary outline-none placeholder:text-flock-ink-muted"
        />
        <ul id="command-palette-list" role="listbox" className="max-h-80 overflow-y-auto py-1">
          {flat.length === 0 ? (
            <li className="px-4 py-3 text-sm text-flock-ink-muted">No matching commands</li>
          ) : (
            groups.map((group) => (
              <li key={group.label} role="presentation">
                <div
                  role="presentation"
                  className="px-4 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wide text-flock-ink-muted"
                >
                  {group.label}
                </div>
                <ul role="presentation">
                  {group.items.map(({ command, indices }) => {
                    flatIndex += 1;
                    const i = flatIndex;
                    const Icon = command.icon;
                    const isActive = i === active;
                    return (
                      <li key={`${group.label}-${command.id}`} role="none">
                        <button
                          ref={isActive ? activeRef : undefined}
                          type="button"
                          id={`command-option-${i}`}
                          role="option"
                          aria-selected={isActive}
                          tabIndex={-1}
                          onMouseEnter={() => setActive(i)}
                          onClick={() => runAt(i)}
                          className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm ${
                            isActive
                              ? 'bg-flock-accent/15 text-flock-ink-primary'
                              : 'text-flock-ink-primary/90'
                          }`}
                        >
                          {Icon ? (
                            <Icon
                              className={`size-4 shrink-0 ${
                                isActive ? 'text-flock-accent' : 'text-flock-ink-muted'
                              }`}
                            />
                          ) : null}
                          <span className="min-w-0 flex-1 truncate">
                            <Highlight text={command.title} indices={indices} />
                          </span>
                          {command.shortcut ? (
                            <kbd className="shrink-0 text-2xs text-flock-ink-muted">
                              {command.shortcut}
                            </kbd>
                          ) : command.hint && command.hint !== group.label ? (
                            <span className="shrink-0 text-2xs text-flock-ink-muted">
                              {command.hint}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
