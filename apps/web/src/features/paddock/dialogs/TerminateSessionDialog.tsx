import {
  Button,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui';
import { TriangleAlert } from 'lucide-react';
import { usePaddock } from '../../../store/paddock';
import { useSessions, useTerminateSession } from '../../../data/queries';

export function TerminateSessionDialog(): JSX.Element {
  const sessionId = usePaddock((s) => s.dialogSessionId);
  const closeDialog = usePaddock((s) => s.closeDialog);
  const selectedSessionId = usePaddock((s) => s.selectedSessionId);
  const selectSession = usePaddock((s) => s.selectSession);
  const selectProject = usePaddock((s) => s.selectProject);
  const { data: sessions = [] } = useSessions();
  const terminate = useTerminateSession();
  const session = sessions.find((s) => s.id === sessionId);
  const busy = terminate.isPending;

  async function onConfirm(): Promise<void> {
    if (!sessionId) return;
    // Capture the project BEFORE the delete so we can keep the view scoped to it.
    const projectId = session?.projectId ?? null;
    try {
      await terminate.mutateAsync(sessionId);
      // If the deleted session was the selected one, fall back to its PROJECT
      // rather than clearing the selection outright — otherwise contextProjectId
      // goes null and the grouped Pen view collapses to a flat agent list.
      if (selectedSessionId === sessionId) {
        if (projectId) selectProject(projectId);
        else selectSession(null);
      }
      closeDialog();
    } catch {
      /* error toast handled by the mutation */
    }
  }

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <TriangleAlert className="size-4 text-status-error" /> Terminate session?
        </DialogTitle>
        <DialogDescription>
          This stops the agent and kills its session
          {session ? ` (${session.agentType} · ${session.id.slice(0, 6)})` : ''}. Any in-progress
          work that isn’t saved will be lost. This can’t be undone.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={closeDialog} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={onConfirm}
          disabled={busy || !sessionId}
        >
          {busy ? 'Terminating…' : 'Terminate'}
        </Button>
      </DialogFooter>
    </div>
  );
}

/** Host that renders whichever dialog the store has open. */
/** flock.yml — paste/edit a workspace config + apply it, or export the current fleet. */
