import { useMemo } from 'react';
import { Dialog, DialogContent } from '../../components/ui';
import { usePaddock } from '../../store/paddock';
import { NodeDialog } from './dialogs/NodeDialog';
import { AddProjectDialog } from './dialogs/AddProjectDialog';
import { AddSessionDialog } from './dialogs/AddSessionDialog';
import { TerminateSessionDialog } from './dialogs/TerminateSessionDialog';
import { ConfigDialog } from './dialogs/ConfigDialog';
import { RaceDialog } from './dialogs/RaceDialog';

/** Renders the active Paddock dialog; each form owns an isolated lifecycle. */
export function PaddockDialogs(): JSX.Element {
  const dialog = usePaddock((state) => state.dialog);
  const closeDialog = usePaddock((state) => state.closeDialog);
  const body = useMemo(() => {
    if (dialog === 'node') return <NodeDialog />;
    if (dialog === 'project') return <AddProjectDialog />;
    if (dialog === 'session') return <AddSessionDialog />;
    if (dialog === 'terminate-session') return <TerminateSessionDialog />;
    if (dialog === 'config') return <ConfigDialog />;
    if (dialog === 'race') return <RaceDialog />;
    return null;
  }, [dialog]);

  return (
    <Dialog open={body !== null} onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent>{body}</DialogContent>
    </Dialog>
  );
}
