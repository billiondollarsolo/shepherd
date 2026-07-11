/**
 * RespondBar (control plane) — answer a blocked agent WITHOUT diving into the
 * terminal. Appears only when the focused session is `awaiting_input` (the money
 * state); sends your decision/reply straight to the agent via the focused
 * terminal's input seam (`terminalInput`).
 *
 * "Send y" / "Send n" are the prominent one-click path — they TYPE the agent's
 * accept/reject keystroke into the PTY (the agent reads it as stdin); a free-text
 * reply + a couple of quick keys cover everything else. This is a keystroke relay,
 * not a structured gate.
 */
import { useState } from 'react';
import { Check, X } from 'lucide-react';
import type { Session } from '@flock/shared';
import { Button } from '../../components/ui';
import { usePaddock } from '../../store/paddock';
import { useLiveStatuses } from './liveData';

/** Send raw input to the focused session's terminal (the agent reads it as stdin). */
function send(text: string): void {
  usePaddock.getState().terminalInput?.(text);
}

export function RespondBar({ session }: { session: Session }): JSX.Element | null {
  const status = useLiveStatuses().get(session.id) ?? session.status;
  const [reply, setReply] = useState('');
  if (status !== 'awaiting_input') return null;

  const sendReply = (): void => {
    const text = reply.trim();
    send(text.length > 0 ? `${text}\r` : '\r');
    setReply('');
  };

  return (
    <div
      data-testid="respond-bar"
      className="flex items-center gap-2 border-b border-status-awaiting/40 bg-status-awaiting/10 px-4 py-1.5 text-xs"
    >
      <span className="shrink-0 font-medium text-status-awaiting">Waiting on you</span>

      {/* Send the agent's accept/reject keystroke (read as stdin). */}
      <Button
        size="sm"
        data-testid="respond-approve"
        title="Type 'y' + Enter into the agent's prompt"
        onClick={() => send('y\r')}
        className="gap-1 bg-status-running/15 text-status-running hover:bg-status-running/25"
      >
        <Check className="size-3.5" /> Send y
      </Button>
      <Button
        size="sm"
        data-testid="respond-deny"
        title="Type 'n' + Enter into the agent's prompt"
        onClick={() => send('n\r')}
        className="gap-1 bg-status-error/15 text-status-error hover:bg-status-error/25"
      >
        <X className="size-3.5" /> Send n
      </Button>

      <span className="text-flock-ink-muted/40">|</span>

      <input
        data-testid="respond-input"
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') sendReply();
        }}
        placeholder="…or type a reply"
        className="min-w-0 flex-1 rounded border border-[var(--flock-border)] bg-flock-surface-1 px-2 py-1 text-flock-fg placeholder:text-flock-muted focus:outline-none focus:ring-1 focus:ring-status-awaiting"
      />
      <Button size="sm" variant="secondary" data-testid="respond-send" onClick={sendReply}>
        Send
      </Button>
      <Button
        size="sm"
        variant="ghost"
        title="Send Enter (accept default)"
        onClick={() => send('\r')}
      >
        ⏎
      </Button>
      <Button size="sm" variant="ghost" title="Send Escape" onClick={() => send('\x1b')}>
        Esc
      </Button>
    </div>
  );
}

export default RespondBar;
