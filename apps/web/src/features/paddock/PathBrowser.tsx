/**
 * PathBrowser — a directory picker that walks the filesystem ON a node (local or
 * remote/ssh) so you choose a working dir by clicking instead of typing it.
 *
 * It opens in a dialog, lists the node's home dir first, lets you drill into
 * sub-directories or go up (..), and "Use this folder" returns the current
 * absolute path. Built on the paddock UI primitives; data via `useNodeDir`.
 */
import { useState } from 'react';
import {
  ArrowUp,
  Check,
  Folder,
  FolderOpen,
  FolderPlus,
  Home,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ScrollArea,
} from '../../components/ui';
import { useMakeNodeDir, useNodeDir } from '../../data/queries';

export interface PathBrowserProps {
  /** The node whose filesystem we browse. */
  nodeId: string;
  /** Optional starting path; defaults to the node's home dir. */
  initialPath?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen absolute directory path. */
  onSelect: (path: string) => void;
}

export function PathBrowser({
  nodeId,
  initialPath,
  open,
  onOpenChange,
  onSelect,
}: PathBrowserProps): JSX.Element {
  // `undefined` path = the node's home dir (resolved server-side).
  const [path, setPath] = useState<string | undefined>(initialPath);
  const { data, isLoading, isError, error, refetch, isFetching } = useNodeDir(nodeId, path, open);

  const current = data?.path ?? path ?? '~';

  // "New folder": create a dir in the RESOLVED current dir, then drill into it.
  const mkdir = useMakeNodeDir(nodeId);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const canCreate = !!data?.path && !mkdir.isPending;
  const submitNewFolder = (): void => {
    const name = newName.trim();
    const parent = data?.path;
    if (!name || !parent) return;
    mkdir.mutate(
      { parent, name },
      {
        onSuccess: (res) => {
          setCreating(false);
          setNewName('');
          setPath(res.path); // step into the freshly-created folder
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen className="size-4 text-flock-accent" /> Choose a folder
          </DialogTitle>
          <DialogDescription>
            Browse directories on the node and pick a working dir.
          </DialogDescription>
        </DialogHeader>

        {/* Current path + nav controls */}
        <div className="flex items-center gap-1.5">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Home directory"
            title="Home"
            onClick={() => setPath(undefined)}
          >
            <Home className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Up one level"
            title="Up one level"
            disabled={!data?.parent}
            onClick={() => data?.parent && setPath(data.parent)}
          >
            <ArrowUp className="size-4" />
          </Button>
          <code className="min-w-0 flex-1 truncate rounded-md border border-[var(--flock-border)] bg-flock-surface-0 px-2.5 py-1.5 text-xs text-flock-ink-primary">
            {current}
          </code>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh"
            title="Refresh"
            onClick={() => void refetch()}
          >
            <RefreshCw className={`size-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="New folder"
            title="New folder here"
            disabled={!canCreate}
            onClick={() => setCreating((v) => !v)}
          >
            <FolderPlus className="size-4" />
          </Button>
        </div>

        {/* New-folder inline form (created in the current dir, then stepped into) */}
        {creating ? (
          <div className="flex items-center gap-1.5" data-testid="new-folder-form">
            <FolderPlus className="size-4 shrink-0 text-flock-accent" />
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNewFolder();
                else if (e.key === 'Escape') {
                  setCreating(false);
                  setNewName('');
                }
              }}
              placeholder="New folder name"
              aria-label="New folder name"
              className="min-w-0 flex-1 rounded-md border border-[var(--flock-border)] bg-flock-surface-0 px-2.5 py-1.5 text-xs text-flock-ink-primary outline-none focus:border-flock-accent"
            />
            <Button
              size="sm"
              type="button"
              loading={mkdir.isPending}
              loadingText="Creating…"
              disabled={!newName.trim() || !canCreate}
              onClick={submitNewFolder}
            >
              <Check className="size-4" /> Create
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Cancel new folder"
              onClick={() => {
                setCreating(false);
                setNewName('');
              }}
            >
              <X className="size-4" />
            </Button>
          </div>
        ) : null}

        {/* Directory list */}
        <ScrollArea className="h-64 rounded-md border border-[var(--flock-border)] bg-flock-surface-1">
          <div className="p-1" data-testid="path-browser-list">
            {isLoading ? (
              <div className="flex h-56 items-center justify-center text-sm text-flock-ink-muted">
                <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
              </div>
            ) : isError ? (
              <div className="flex h-56 flex-col items-center justify-center gap-1 px-6 text-center">
                <p className="text-sm text-status-error">Can’t open this folder.</p>
                <p className="text-2xs text-flock-ink-muted">
                  {error instanceof Error ? error.message : 'The node may be unreachable.'}
                </p>
              </div>
            ) : data && data.entries.length === 0 ? (
              <p className="flex h-56 items-center justify-center text-sm text-flock-ink-muted">
                No sub-folders here.
              </p>
            ) : (
              data?.entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onDoubleClick={() => setPath(entry.path)}
                  onClick={() => setPath(entry.path)}
                  data-testid={`path-entry-${entry.name}`}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-flock-ink-primary transition-colors hover:bg-flock-surface-2"
                >
                  <Folder className="size-4 shrink-0 text-flock-ink-muted" />
                  <span className="truncate">{entry.name}</span>
                </button>
              ))
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!data?.path}
            onClick={() => {
              if (data?.path) {
                onSelect(data.path);
                onOpenChange(false);
              }
            }}
          >
            <Check className="size-4" /> Use this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
