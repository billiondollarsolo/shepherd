/**
 * SearchPanel — Find-in-Files for a session's working dir, powered by ripgrep on
 * the node (gitignore-aware) via /api/nodes/:id/search. Case / whole-word / regex
 * toggles, grouped results, click a hit to open it in the file viewer.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CaseSensitive, Regex, Search, WholeWord } from 'lucide-react';
import type { Session } from '@flock/shared';

import { searchNode, type SearchResult } from '../../data/treeApi';
import { usePaddock } from '../../store/paddock';
import { ScrollArea, SimpleTooltip } from '../../components/ui';

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
          on ? 'bg-flock-accent/20 text-flock-accent' : 'text-flock-ink-muted hover:bg-flock-surface-2'
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
  const openFileInViewer = usePaddock((s) => s.openFileInViewer);

  const run = useMutation<SearchResult, Error, void>({
    mutationFn: () =>
      searchNode(session.nodeId, session.workingDir, query.trim(), {
        caseSensitive,
        wholeWord,
        regex,
      }),
  });

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (query.trim()) run.mutate();
  }

  const result = run.data;
  const fileCount = result ? new Set(result.matches.map((m) => m.file)).size : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form onSubmit={onSubmit} className="border-b border-[var(--flock-border)] p-2">
        <div className="flex items-center gap-1 rounded-md border border-[var(--flock-border)] bg-flock-surface-1 px-2 py-1 focus-within:border-flock-accent">
          <Search className="size-3.5 shrink-0 text-flock-ink-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find in files…"
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-sm text-flock-ink-primary outline-none placeholder:text-flock-ink-muted/60"
          />
          <Toggle on={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} label="Match case" icon={CaseSensitive} />
          <Toggle on={wholeWord} onClick={() => setWholeWord((v) => !v)} label="Whole word" icon={WholeWord} />
          <Toggle on={regex} onClick={() => setRegex((v) => !v)} label="Regex" icon={Regex} />
        </div>
        {result ? (
          <p className="mt-1.5 px-1 text-2xs text-flock-ink-muted">
            {result.matches.length} {result.matches.length === 1 ? 'result' : 'results'} in {fileCount}{' '}
            {fileCount === 1 ? 'file' : 'files'}
            {result.truncated ? ' (truncated)' : ''}
          </p>
        ) : null}
      </form>

      <ScrollArea className="min-h-0 flex-1">
        {run.isPending ? (
          <p className="p-3 text-sm text-flock-ink-muted">Searching…</p>
        ) : run.isError ? (
          <p className="p-3 text-sm text-status-error">{run.error.message}</p>
        ) : result && result.matches.length === 0 ? (
          <p className="p-3 text-sm text-flock-ink-muted">No matches.</p>
        ) : (
          <ul className="p-1">
            {(result?.matches ?? []).map((m, i) => (
              <li key={`${m.file}:${m.line}:${i}`}>
                <button
                  type="button"
                  onClick={() => openFileInViewer(`${session.workingDir}/${m.file}`)}
                  className="flex w-full min-w-0 items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-flock-surface-2"
                  data-testid="search-result"
                >
                  <span className="shrink-0 font-mono text-2xs text-flock-ink-muted">
                    {m.file}:{m.line}
                  </span>
                  <span className="truncate font-mono text-2xs text-flock-ink-primary/90">{m.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
