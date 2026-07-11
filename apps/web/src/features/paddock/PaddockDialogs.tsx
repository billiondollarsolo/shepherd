import { useEffect, useMemo, useRef } from 'react';
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
  const restoreFocus = useRef<HTMLElement | null>(null);

  // Radix can restore focus automatically when a DialogTrigger owns the modal.
  // These app-level dialogs are opened through Zustand (often from a dropdown),
  // so remember the durable trigger ourselves. A menu item is ephemeral: resolve
  // it to the menu's aria-controls trigger while the menu still exists.
  useEffect(() => {
    if (dialog !== null) return;
    const remember = (event: FocusEvent): void => {
      if (!(event.target instanceof HTMLElement)) return;
      const menu = event.target.closest<HTMLElement>('[role="menu"]');
      const trigger = menu?.id
        ? [...document.querySelectorAll<HTMLElement>('[aria-controls]')].find(
            (candidate) => candidate.getAttribute('aria-controls') === menu.id,
          )
        : null;
      restoreFocus.current = trigger ?? event.target;
    };
    document.addEventListener('focusin', remember);
    return () => document.removeEventListener('focusin', remember);
  }, [dialog]);
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
      <DialogContent
        onCloseAutoFocus={(event) => {
          const target = restoreFocus.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        {body}
      </DialogContent>
    </Dialog>
  );
}
