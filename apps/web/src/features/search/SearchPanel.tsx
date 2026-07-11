/**
 * SearchPanel — Find-in-Files for a session's working dir, powered by ripgrep on
 * the node (gitignore-aware) via /api/nodes/:id/search. Case / whole-word / regex
 * toggles, grouped results, click a hit to open it in the file viewer.
 */
import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CaseSensitive, Regex, Search, WholeWord } from 'lucide-react';
import type { Session } from '@flock/shared';

import { searchNode, type SearchResult, type SearchMatch } from '../../data/treeApi';
import { usePaddock } from '../../store/paddock';
import { ScrollArea, SimpleTooltip } from '../../components/ui';

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
      </form>

      <ScrollArea className="min-h-0 flex-1">
        {run.isPending ? (
          <p className="p-3 text-sm text-flock-ink-muted">Searching…</p>
        ) : run.isError ? (
          <p className="p-3 text-sm text-status-error">{run.error.message}</p>
        ) : !result ? (
          <p className="p-3 text-xs text-flock-ink-muted">
            {query.trim()
              ? 'Press Enter to search.'
              : 'Type a query, then press Enter to search the working dir.'}
          </p>
        ) : result.matches.length === 0 ? (
          <p className="p-3 text-sm text-flock-ink-muted">No matches.</p>
        ) : (
          <ul className="p-1">
            {groupByFile(result.matches).map(([file, hits]) => (
              <li key={file} className="mb-1.5">
                {/* file header — group all matches in a file under one collapsible-style row */}
                <div className="flex items-center gap-1.5 px-2 py-1 text-2xs font-medium text-flock-ink-muted">
                  <span className="truncate font-mono text-flock-ink-primary/90">{file}</span>
                  <span className="shrink-0 rounded-full bg-flock-surface-2 px-1.5 tabular-nums">
                    {hits.length}
                  </span>
                </div>
                {hits.map((m, i) => (
                  <button
                    key={`${m.line}:${i}`}
                    type="button"
                    onClick={() => openFileInViewer(`${session.workingDir}/${m.file}`)}
                    className="flex w-full min-w-0 items-baseline gap-2 rounded py-0.5 pl-5 pr-2 text-left hover:bg-flock-surface-2"
                    data-testid="search-result"
                  >
                    <span className="w-8 shrink-0 text-right font-mono text-2xs tabular-nums text-flock-ink-muted/70">
                      {m.line}
                    </span>
                    <span className="truncate font-mono text-2xs text-flock-ink-primary/90">
                      {highlight(m.text, query.trim(), !regex)}
                    </span>
                  </button>
                ))}
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
