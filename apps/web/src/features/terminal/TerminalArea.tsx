/**
 * TerminalArea — the focus view's terminal for ONE session. In Flock's model a
 * session IS a single terminal (agent / shell / dev); to run more terminals you
 * add more sessions to the project (shown in the sidebar, tabs, and grid). So
 * there are no in-session splits here — just the session's live terminal, plus
 * the drag-and-drop target:
 *   - drop a Files-tree file → insert its path at the prompt;
 *   - drop an OS file        → upload to the working dir, then insert the path.
 * The terminal registers its PTY writer into the paddock store so the tree / drops
 * can type into it.
 */
import { lazy, Suspense, type DragEvent } from 'react';
import type { Session } from '@flock/shared';

import { usePaddock } from '../../store/paddock';
import { useWriteNodeFile } from '../../data/queries';
import { bytesToBase64 } from '../files/base64';
import { toast } from '../../components/ui';

const Terminal = lazy(() => import('./Terminal'));

function shellQuote(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

export function TerminalArea({
  session,
  register = true,
}: {
  session: Session;
  /**
   * Whether THIS terminal claims the shared "terminal input" writer (so the file
   * tree / drag-drop type into it). Only the currently-focused terminal should —
   * in the grid every cell is mounted at once, so they'd otherwise stomp each
   * other. Defaults true for standalone use.
   */
  register?: boolean;
}): JSX.Element {
  const write = useWriteNodeFile(session.nodeId);
  const setTerminalInput = usePaddock((s) => s.setTerminalInput);
  const insert = (text: string): void => usePaddock.getState().terminalInput?.(text);

  function onDragOver(e: DragEvent): void {
    if (
      e.dataTransfer.types.includes('application/x-flock-path') ||
      e.dataTransfer.types.includes('Files')
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }
  async function onDrop(e: DragEvent): Promise<void> {
    const treePath = e.dataTransfer.getData('application/x-flock-path');
    if (treePath) {
      e.preventDefault();
      insert(shellQuote(treePath) + ' ');
      return;
    }
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    for (const file of files) {
      const dest = `${session.workingDir.replace(/\/$/, '')}/${file.name}`;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await write.mutateAsync({ path: dest, contentBase64: bytesToBase64(bytes) });
        toast.success(`Uploaded ${file.name}`);
        insert(shellQuote(dest) + ' ');
      } catch {
        /* mutation surfaces its own error toast */
      }
    }
  }

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col"
      onDragOver={onDragOver}
      onDrop={(e) => void onDrop(e)}
      data-testid="terminal-area"
    >
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div
              className="flex h-full items-center justify-center bg-[#090909] text-xs text-[#a1a1aa]"
              role="status"
            >
              Loading terminal…
            </div>
          }
        >
          <Terminal
            sessionId={session.id}
            registerInput={register ? setTerminalInput : undefined}
          />
        </Suspense>
      </div>
    </div>
  );
}
