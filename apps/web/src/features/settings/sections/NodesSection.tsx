import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge, Button } from '../../../components/ui';
import { useDeleteNode, useNodes } from '../../../data/queries';
import { usePaddock } from '../../../store/paddock';
import { SectionHeader } from '../SettingsSection';

export function NodesSection(): JSX.Element {
  const { data: nodes = [] } = useNodes();
  const deleteNode = useDeleteNode();
  const openDialog = usePaddock((s) => s.openDialog);

  return (
    <div>
      <SectionHeader
        title="Nodes"
        description="Execution targets — this machine, or remote hosts over SSH."
        action={
          <Button size="sm" onClick={() => openDialog('node')}>
            <Plus /> Add node
          </Button>
        }
      />
      <div className="grid gap-2">
        {nodes.length === 0 && (
          <p className="rounded-lg border border-dashed border-[var(--flock-border)] py-10 text-center text-sm text-flock-ink-muted">
            No nodes yet.
          </p>
        )}
        {nodes.map((n) => (
          <div
            key={n.id}
            className="flex items-center justify-between rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 px-4 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-flock-ink-primary">{n.name}</p>
              <p className="truncate text-2xs text-flock-ink-muted">
                {n.kind === 'ssh' ? `${n.sshUser}@${n.host}:${n.port ?? 22}` : 'local orchestrator'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={n.connectionStatus === 'connected' ? 'success' : 'neutral'}>
                {n.connectionStatus}
              </Badge>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Edit node"
                onClick={() => openDialog('node', { nodeId: n.id })}
              >
                <Pencil />
              </Button>
              {n.kind !== 'local' && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Remove node"
                  onClick={() => deleteNode.mutate(n.id)}
                >
                  <Trash2 className="text-status-error" />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
