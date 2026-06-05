/**
 * FilesPanel — a VS Code / Orca-style file browser for the session's node,
 * rooted at the session working dir. A lazy tree (dirs + files over the node
 * transport) on top; clicking a file opens a read-only viewer that can flip to
 * an editor (save writes back to the node). File rows are draggable — drop one
 * on the terminal to insert its path (handled by the terminal drop zone), or use
 * the "Insert" / "Edit" affordances here.
 */
import { lazy, Suspense, useState } from 'react';
import type { Session } from '@flock/shared';
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  ArrowLeft,
  Pencil,
  Save,
  TerminalSquare,
} from 'lucide-react';

import { usePaddock } from '../../store/paddock';
import { useNodeFsTree, useNodeFile, useWriteNodeFile } from '../../data/queries';
import { decodeFileContent, textToBase64 } from './base64';
// Lazy: CodeMirror is a large bundle — only load it when a file is actually opened.
const CodeEditor = lazy(() => import('./CodeEditor'));

/** Quote a path for the shell if it contains anything beyond safe chars. */
function shellQuote(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

export interface FilesPanelProps {
  session: Session;
}

export default function FilesPanel({ session }: FilesPanelProps): JSX.Element {
  // The opened file lives in the store so Find-in-Files results can deep-link here.
  const selected = usePaddock((s) => s.viewerFile);
  const openFile = usePaddock((s) => s.openFileInViewer);
  const closeFile = usePaddock((s) => s.closeFileViewer);

  if (selected) {
    return <FileViewer nodeId={session.nodeId} path={selected} onBack={closeFile} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-flock-bg" data-testid="files-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--flock-border)] px-3 text-xs">
        <span className="truncate font-mono text-flock-ink-muted" title={session.workingDir}>
          {session.workingDir}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        <FsDir
          nodeId={session.nodeId}
          path={session.workingDir}
          name={session.workingDir.split('/').filter(Boolean).pop() ?? '/'}
          depth={0}
          defaultOpen
          onSelectFile={openFile}
        />
      </div>
    </div>
  );
}

function FsDir({
  nodeId,
  path,
  name,
  depth,
  defaultOpen = false,
  onSelectFile,
}: {
  nodeId: string;
  path: string;
  name: string;
  depth: number;
  defaultOpen?: boolean;
  onSelectFile: (path: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const tree = useNodeFsTree(nodeId, path, open);
  const pad = { paddingLeft: `${depth * 12 + 8}px` };

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={pad}
        className="flex w-full items-center gap-1 py-0.5 pr-2 text-left text-xs text-flock-fg hover:bg-flock-surface-2"
        data-testid={`fs-dir-${path}`}
      >
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        {open ? (
          <FolderOpen className="size-3.5 shrink-0 text-flock-accent" />
        ) : (
          <Folder className="size-3.5 shrink-0 text-flock-accent" />
        )}
        <span className="truncate">{name}</span>
      </button>
      {open ? (
        tree.isLoading ? (
          <p style={{ paddingLeft: `${(depth + 1) * 12 + 20}px` }} className="py-0.5 text-2xs text-flock-muted">
            loading…
          </p>
        ) : tree.isError ? (
          <p
            style={{ paddingLeft: `${(depth + 1) * 12 + 20}px` }}
            className="py-0.5 text-2xs text-status-error"
          >
            {tree.error instanceof Error ? tree.error.message : 'cannot read'}
          </p>
        ) : (
          (tree.data?.entries ?? []).map((e) =>
            e.kind === 'dir' ? (
              <FsDir
                key={e.path}
                nodeId={nodeId}
                path={e.path}
                name={e.name}
                depth={depth + 1}
                onSelectFile={onSelectFile}
              />
            ) : (
              <FsFile key={e.path} path={e.path} name={e.name} depth={depth + 1} onSelect={onSelectFile} />
            ),
          )
        )
      ) : null}
    </div>
  );
}

function FsFile({
  path,
  name,
  depth,
  onSelect,
}: {
  path: string;
  name: string;
  depth: number;
  onSelect: (path: string) => void;
}): JSX.Element {
  const termInput = usePaddock((s) => s.terminalInput);
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        // The terminal drop zone reads this custom type to distinguish an in-app
        // path drag from an OS-file drag; text/plain covers other drop targets.
        e.dataTransfer.setData('application/x-flock-path', path);
        e.dataTransfer.setData('text/plain', path);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => onSelect(path)}
      onDoubleClick={() => termInput?.(shellQuote(path) + ' ')}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      className="flex w-full items-center gap-1 py-0.5 pr-2 text-left text-xs text-flock-fg hover:bg-flock-surface-2"
      data-testid={`fs-file-${path}`}
      title={path}
    >
      <span className="w-3 shrink-0" />
      <FileIcon className="size-3.5 shrink-0 text-flock-ink-muted" />
      <span className="truncate">{name}</span>
    </button>
  );
}

function FileViewer({
  nodeId,
  path,
  onBack,
}: {
  nodeId: string;
  path: string;
  onBack: () => void;
}): JSX.Element {
  const file = useNodeFile(nodeId, path);
  const write = useWriteNodeFile(nodeId);
  const termInput = usePaddock((s) => s.terminalInput);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);

  const decoded = file.data ? decodeFileContent(file.data.contentBase64) : null;
  const name = path.split('/').pop() ?? path;

  const startEdit = (): void => {
    setDraft(decoded?.text ?? '');
    setEditing(true);
  };
  const save = (): void => {
    if (draft == null) return;
    write.mutate(
      { path, contentBase64: textToBase64(draft) },
      { onSuccess: () => setEditing(false) },
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-flock-bg" data-testid="file-viewer">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--flock-border)] px-2 text-xs">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to files"
          className="rounded p-1 text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary"
        >
          <ArrowLeft className="size-4" />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-flock-ink-primary" title={path}>
          {name}
        </span>
        <button
          type="button"
          onClick={() => termInput?.(shellQuote(path) + ' ')}
          title="Insert path in terminal"
          className="rounded p-1 text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary"
        >
          <TerminalSquare className="size-3.5" />
        </button>
        {!editing && decoded && !decoded.binary ? (
          <button
            type="button"
            onClick={startEdit}
            title="Edit"
            className="rounded p-1 text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary"
          >
            <Pencil className="size-3.5" />
          </button>
        ) : null}
        {editing ? (
          <button
            type="button"
            onClick={save}
            disabled={write.isPending}
            data-testid="file-save"
            className="flex items-center gap-1 rounded bg-flock-accent px-2 py-0.5 text-2xs font-medium text-white disabled:opacity-50"
          >
            <Save className="size-3" /> {write.isPending ? 'Saving…' : 'Save'}
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {file.isLoading ? (
          <Centered>Loading…</Centered>
        ) : file.isError ? (
          <Centered tone="error">
            {file.error instanceof Error ? file.error.message : 'Could not read file.'}
          </Centered>
        ) : decoded?.binary ? (
          <Centered>Binary file ({file.data?.size ?? 0} bytes) — preview unavailable.</Centered>
        ) : (
          <Suspense fallback={<Centered>Loading editor…</Centered>}>
            {editing ? (
              <CodeEditor value={draft ?? ''} filename={name} onChange={(v) => setDraft(v)} />
            ) : (
              // Read-only but still syntax-highlighted (Orca-style viewer).
              <CodeEditor value={decoded?.text ?? ''} filename={name} readOnly />
            )}
          </Suspense>
        )}
        {file.data?.truncated ? (
          <p className="px-3 py-1 text-2xs text-flock-muted">
            (truncated — file larger than the read limit)
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Centered({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: 'error';
}): JSX.Element {
  return (
    <div
      className={`flex h-full w-full items-center justify-center px-4 text-center text-sm ${
        tone === 'error' ? 'text-status-error' : 'text-flock-muted'
      }`}
    >
      {children}
    </div>
  );
}
