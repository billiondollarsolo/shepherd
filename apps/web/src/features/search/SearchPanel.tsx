/**
 * SearchPanel — Find-in-Files for a session's working dir, powered by ripgrep on
 * the node (gitignore-aware) via /api/nodes/:id/search. Case / whole-word / regex
 * toggles, grouped results, click a hit to open it in the file viewer.
 *
 * The query runs on a debounce as you type (live search), and the flat result list
 * is a single roving-tabindex group: ArrowUp/Down move the focused hit, Enter opens
 * it — so the whole panel is keyboard-drivable without leaving the input.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CaseSensitive, Regex, Search, WholeWord } from 'lucide-react';
import type { Session } from '@flock/shared';

import { searchNode, type SearchResult, type SearchMatch } from '../../data/treeApi';
import { usePaddock } from '../../store/paddock';
import { EmptyState, ScrollArea, SimpleTooltip } from '../../components/ui';
import { Sheep } from '../../components/SheepIcon';

/** How long the input stays quiet before a live search fires. */
const DEBOUNCE_MS = 250;

/** Debounce a rapidly-changing value. Pure hook — the delay is unit-tested via `debounce`. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = (...args: A): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = (): void => {
    if (timer) clearTimeout(timer);
  };
  return debounced;
}

/** Group flat ripgrep hits by file, preserving first-seen order. */
function groupByFile(matches: SearchMatch[]): Array<[string, SearchMatch[]]> {
  const m = new Map<string, SearchMatch[]>();
  for (const hit of matches) {
    const arr = m.get(hit.file);
    if (arr) arr.push(hit);
    else m.set(hit.file, [hit]);
  }
  return [...m.entries()];
}

/** Highlight every (case-insensitive) occurrence of a plain query in a line. */
function highlight(text: string, q: string, enabled: boolean): ReactNode {
  if (!enabled || !q) return text;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  for (;;) {
    const j = lower.indexOf(ql, i);
    if (j < 0) {
      out.push(text.slice(i));
      break;
    }
    if (j > i) out.push(text.slice(i, j));
    out.push(
      <mark key={key++} className="rounded-sm bg-flock-accent/30 text-flock-ink-primary">
        {text.slice(j, j + q.length)}
      </mark>,
    );
    i = j + q.length;
  }
  return out;
}

function Toggle({
  on,
  onClick,
  label,
  icon: Icon,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  icon: typeof Search;
}): JSX.Element {
  return (
    <SimpleTooltip label={label}>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={on}
        className={`flex size-6 items-center justify-center rounded ${
          on
            ? 'bg-flock-accent/20 text-flock-accent'
            : 'text-flock-ink-muted hover:bg-flock-surface-2'
        }`}
      >
        <Icon className="size-3.5" />
      </button>
    </SimpleTooltip>
  );
}

export default function SearchPanel({ session }: { session: Session }): JSX.Element {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [active, setActive] = useState(0);
  const openFileInViewer = usePaddock((s) => s.openFileInViewer);
  const listRef = useRef<HTMLDivElement>(null);

  const run = useMutation<SearchResult, Error, string>({
    mutationFn: (q: string) =>
      searchNode(session.nodeId, session.workingDir, q, {
        caseSensitive,
        wholeWord,
        regex,
      }),
  });

  // Live search: fire a debounced query as the operator types (or toggles an
  // option). The mutate ref keeps the debounced fn stable across renders.
  const mutateRef = useRef(run.mutate);
  mutateRef.current = run.mutate;
  const debouncedSearch = useMemo(
    () =>
      debounce((q: string) => {
        if (q.trim()) mutateRef.current(q.trim());
      }, DEBOUNCE_MS),
    [],
  );

  useEffect(() => {
    debouncedSearch(query);
    return () => debouncedSearch.cancel();
  }, [query, caseSensitive, wholeWord, regex, debouncedSearch]);

  const result = run.data;
  const fileCount = result ? new Set(result.matches.map((m) => m.file)).size : 0;

  // The flat, in-display order of every hit — the roving-tabindex spine.
  const flatHits = useMemo(() => {
    if (!result) return [] as SearchMatch[];
    return groupByFile(result.matches).flatMap(([, hits]) => hits);
  }, [result]);

  // Clamp the active index whenever the result set changes.
  useEffect(() => {
    setActive((i) => (flatHits.length === 0 ? 0 : Math.min(i, flatHits.length - 1)));
  }, [flatHits.length]);

  const openHit = useCallback(
    (m: SearchMatch) => openFileInViewer(`${session.workingDir}/${m.file}`),
    [openFileInViewer, session.workingDir],
  );

  // Move the roving focus and keep the newly-active hit in view.
  const move = useCallback(
    (delta: number) => {
      setActive((i) => {
        const next = Math.max(0, Math.min(flatHits.length - 1, i + delta));
        const el = listRef.current?.querySelector<HTMLElement>(`[data-hit-index="${next}"]`);
        el?.scrollIntoView({ block: 'nearest' });
        el?.focus();
        return next;
      });
    },
    [flatHits.length],
  );

  function onListKeyDown(e: React.KeyboardEvent): void {
    if (flatHits.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = flatHits[active];
      if (hit) openHit(hit);
    }
  }

  function onInputKeyDown(e: React.KeyboardEvent): void {
    // From the input, ArrowDown dives into the result list.
    if (e.key === 'ArrowDown' && flatHits.length > 0) {
      e.preventDefault();
      setActive(0);
      const el = listRef.current?.querySelector<HTMLElement>('[data-hit-index="0"]');
      el?.focus();
    }
  }

  let hitIndex = -1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-[var(--flock-border)] p-2">
        <div className="flex items-center gap-1 rounded-md border border-[var(--flock-border)] bg-flock-surface-1 px-2 py-1 focus-within:border-flock-accent">
          <Search className="size-3.5 shrink-0 text-flock-ink-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Find in files…"
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-sm text-flock-ink-primary outline-none placeholder:text-flock-ink-muted"
          />
          <Toggle
            on={caseSensitive}
            onClick={() => setCaseSensitive((v) => !v)}
            label="Match case"
            icon={CaseSensitive}
          />
          <Toggle
            on={wholeWord}
            onClick={() => setWholeWord((v) => !v)}
            label="Whole word"
            icon={WholeWord}
          />
          <Toggle on={regex} onClick={() => setRegex((v) => !v)} label="Regex" icon={Regex} />
        </div>
        {result ? (
          <p className="mt-1.5 px-1 text-2xs text-flock-ink-muted">
            {result.matches.length} {result.matches.length === 1 ? 'result' : 'results'} in{' '}
            {fileCount} {fileCount === 1 ? 'file' : 'files'}
            {result.truncated ? ' (truncated)' : ''}
          </p>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {run.isPending ? (
          <p className="p-3 text-sm text-flock-ink-muted">Searching…</p>
        ) : run.isError ? (
          <p className="p-3 text-sm text-status-error">{run.error.message}</p>
        ) : !result ? (
          <EmptyState
            icon={<Sheep className="text-flock-ink-muted" />}
            title="Find in files"
            description={
              query.trim()
                ? 'Searching the working dir…'
                : 'Type a query to search the working dir. Results appear as you type.'
            }
          />
        ) : result.matches.length === 0 ? (
          <p className="p-3 text-sm text-flock-ink-muted">No matches.</p>
        ) : (
          <div
            ref={listRef}
            role="listbox"
            aria-label="Search results"
            onKeyDown={onListKeyDown}
            className="p-1"
          >
            {groupByFile(result.matches).map(([file, hits]) => (
              <div key={file} className="mb-1.5">
                {/* file header — group all matches in a file under one collapsible-style row */}
                <div className="flex items-center gap-1.5 px-2 py-1 text-2xs font-medium text-flock-ink-muted">
                  <span className="truncate font-mono text-flock-ink-primary/90">{file}</span>
                  <span className="shrink-0 rounded-full bg-flock-surface-2 px-1.5 tabular-nums">
                    {hits.length}
                  </span>
                </div>
                {hits.map((m, i) => {
                  hitIndex += 1;
                  const idx = hitIndex;
                  return (
                    <button
                      key={`${m.line}:${i}`}
                      type="button"
                      role="option"
                      aria-selected={idx === active}
                      data-hit-index={idx}
                      tabIndex={idx === active ? 0 : -1}
                      onClick={() => {
                        setActive(idx);
                        openHit(m);
                      }}
                      onFocus={() => setActive(idx)}
                      className={`flex w-full min-w-0 items-baseline gap-2 rounded py-0.5 pl-5 pr-2 text-left outline-none hover:bg-flock-surface-2 focus-visible:bg-flock-surface-2 ${
                        idx === active ? 'bg-flock-accent/12' : ''
                      }`}
                      data-testid="search-result"
                    >
                      <span className="w-8 shrink-0 text-right font-mono text-2xs tabular-nums text-flock-ink-muted/70">
                        {m.line}
                      </span>
                      <span className="truncate font-mono text-2xs text-flock-ink-primary/90">
                        {highlight(m.text, query.trim(), !regex)}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
