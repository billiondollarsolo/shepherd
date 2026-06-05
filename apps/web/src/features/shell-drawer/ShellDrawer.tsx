/**
 * US-35 — Bottom shell drawer.
 *
 * A *second* user shell in the session's working dir, distinct from the agent
 * terminal (spec §12.2). It opens the PTY for the DERIVED {@link shellSessionId}
 * (`<id>:shell`) — the orchestrator routes that suffix to its own persistent tmux
 * shell in the working dir — so poking around here never disturbs the agent's
 * terminal.
 *
 * It REUSES the main {@link Terminal} component (xterm.js + WebGL + the Nerd font
 * + correct fit/VT handling) rather than a bespoke xterm, so the drawer renders
 * identically to the agent terminal (the old hand-rolled xterm had the font-var
 * bug + leaked DA responses like `0;276;0c`).
 */
import Terminal from '../terminal/Terminal';
import type { WsFactory } from '../terminal/usePtyWebSocket';
import { agentTerminalSessionId, shellSessionId } from './types';
import './ShellDrawer.css';

export interface ShellDrawerProps {
  /** The single authoritative session id (spec §4.2). */
  sessionId: string;
  /** The session's working directory, shown as context (display-only). */
  workingDir: string;
  /** Optional close affordance (e.g. wired to KeyboardProvider.toggleDrawer). */
  onClose?: () => void;
  /** Injected for tests; forwarded to the inner Terminal's PTY socket. */
  wsFactory?: WsFactory;
}

export function ShellDrawer({
  sessionId,
  workingDir,
  onClose,
  wsFactory,
}: ShellDrawerProps): JSX.Element {
  // Distinct PTY: the derived shell session, never the agent's own id.
  const ptyId = shellSessionId(sessionId);

  return (
    <section
      className="flock-shell-drawer"
      data-testid="shell-drawer"
      role="region"
      aria-label="Session shell"
      data-session-id={sessionId}
      data-shell-session={ptyId}
      data-agent-session={agentTerminalSessionId(sessionId)}
    >
      <header className="flock-shell-drawer__bar">
        <span className="flock-shell-drawer__title">Shell</span>
        <span
          className="flock-shell-drawer__cwd"
          title={workingDir}
          aria-label="working directory"
        >
          {workingDir}
        </span>
        <span className="flock-shell-drawer__spacer" />
        {onClose ? (
          <button
            type="button"
            className="flock-shell-drawer__close"
            aria-label="Close shell drawer"
            onClick={onClose}
          >
            {'×'}
          </button>
        ) : null}
      </header>
      <div className="flock-shell-drawer__term" data-testid="shell-term">
        <Terminal key={ptyId} sessionId={ptyId} wsFactory={wsFactory} />
      </div>
    </section>
  );
}
