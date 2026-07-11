import { useMemo, useState, type FormEvent } from 'react';
import { FolderGit2, FolderOpen } from 'lucide-react';
import {
  Button,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui';
import { usePaddock } from '../../../store/paddock';
import { useCreateProject, useNodes, useSessions } from '../../../data/queries';
import { PathBrowser } from '../PathBrowser';
import { pickBestNode } from '../placement';
import { DialogField as Field } from './DialogField';

const AUTO_NODE = '__auto__';

export function AddProjectDialog(): JSX.Element {
  const { data: nodes = [] } = useNodes();
  const { data: sessions = [] } = useSessions();
  const fixedNodeId = usePaddock((s) => s.dialogNodeId);
  const createProject = useCreateProject();
  const closeDialog = usePaddock((s) => s.closeDialog);
  const [nodeId, setNodeId] = useState(fixedNodeId ?? nodes[0]?.id ?? '');
  const [name, setName] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [browseOpen, setBrowseOpen] = useState(false);
  const busy = createProject.isPending;

  // Auto resolves to the least-busy reachable node (opt-in only). Show which one.
  const autoTarget = useMemo(() => pickBestNode(nodes, sessions), [nodes, sessions]);
  const effectiveNodeId = nodeId === AUTO_NODE ? (autoTarget?.id ?? '') : nodeId;
  const selectedNode = nodes.find((n) => n.id === effectiveNodeId);
  // Browsing runs a command on the node, so it needs a reachable transport: a
  // local node, or an ssh node that is currently connected.
  const canBrowse =
    !!selectedNode &&
    (selectedNode.kind === 'local' || selectedNode.connectionStatus === 'connected');

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const resolvedNodeId = nodeId === AUTO_NODE ? autoTarget?.id : nodeId;
    if (!resolvedNodeId) return; // Auto found no reachable node — nothing to do
    try {
      await createProject.mutateAsync({
        nodeId: resolvedNodeId,
        name: name.trim(),
        workingDir: workingDir.trim(),
      });
      closeDialog();
    } catch {
      /* error toast handled by the mutation */
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <FolderGit2 className="size-4 text-flock-accent" /> Add project
        </DialogTitle>
        <DialogDescription>A working directory / repo root on a node.</DialogDescription>
      </DialogHeader>

      <Field
        label="Node"
        htmlFor="proj-node"
        hint={
          nodeId === AUTO_NODE
            ? autoTarget
              ? `Auto → ${autoTarget.name} (least busy${autoTarget.pool ? ` · ${autoTarget.pool}` : ''})`
              : 'Auto → no reachable node available'
            : undefined
        }
      >
        <Select value={nodeId} onValueChange={setNodeId} disabled={!!fixedNodeId}>
          <SelectTrigger id="proj-node">
            <SelectValue placeholder="Select a node" />
          </SelectTrigger>
          <SelectContent>
            {!fixedNodeId ? <SelectItem value={AUTO_NODE}>✨ Auto (best node)</SelectItem> : null}
            {nodes.map((n) => (
              <SelectItem key={n.id} value={n.id}>
                {n.name}
                {n.pool ? ` · ${n.pool}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Name" htmlFor="proj-name">
        <Input
          id="proj-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="flock"
          autoFocus
          required
        />
      </Field>
      <Field
        label="Working directory"
        htmlFor="proj-dir"
        hint={canBrowse ? undefined : 'Connect the node to browse, or type the path.'}
      >
        <div className="flex items-center gap-2">
          <Input
            id="proj-dir"
            className="flex-1"
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            placeholder="/home/user/projects/flock"
            required
          />
          <Button
            type="button"
            variant="secondary"
            size="md"
            disabled={!canBrowse}
            onClick={() => setBrowseOpen(true)}
            title={canBrowse ? 'Browse folders on the node' : 'Node must be connected to browse'}
          >
            <FolderOpen className="size-4" /> Browse
          </Button>
        </div>
      </Field>

      {browseOpen && selectedNode && (
        <PathBrowser
          nodeId={selectedNode.id}
          initialPath={workingDir.trim() || undefined}
          open={browseOpen}
          onOpenChange={setBrowseOpen}
          onSelect={(p) => setWorkingDir(p)}
        />
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={closeDialog}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !nodeId || !name.trim() || !workingDir.trim()}>
          {busy ? 'Adding…' : 'Add project'}
        </Button>
      </DialogFooter>
    </form>
  );
}
