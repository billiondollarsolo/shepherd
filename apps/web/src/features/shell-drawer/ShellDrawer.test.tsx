import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ShellDrawer } from './ShellDrawer';
import type { WsLike } from '../terminal/usePtyWebSocket';
import { agentTerminalSessionId, shellSessionId } from './types';

/**
 * The drawer now reuses the main <Terminal> (xterm I/O is covered by
 * Terminal.test.tsx). These assert the DRAWER's own responsibilities: it opens a
 * PTY on a DISTINCT `<id>:shell` id, shows the cwd, and the close affordance.
 */

/** Fake WebSocket for the shared PTY hook (forwarded into the inner Terminal). */
class FakeWs implements WsLike {
  binaryType = 'blob';
  readyState = 0;
  sent: Array<string | ArrayBufferView | ArrayBuffer> = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | ArrayBufferView | string }) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string | ArrayBufferView | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {}
}

const baseProps = { sessionId: 'sess-alpha', workingDir: '/srv/api' };

describe('US-35 ShellDrawer component (spec §12.2, PRD §12.2)', () => {
  it('opens a PTY on the DERIVED shell id, DISTINCT from the agent terminal (the money assertion)', () => {
    let socket: FakeWs | undefined;
    const { getByTestId } = render(
      <ShellDrawer {...baseProps} wsFactory={(url) => (socket = new FakeWs(url))} />,
    );
    // The drawer's PTY is the derived shell id, never the agent's bare id.
    expect(socket!.url).toContain('/ws/pty/sess-alpha%3Ashell');
    expect(socket!.url).not.toContain('/ws/pty/sess-alpha?');
    const drawer = getByTestId('shell-drawer');
    expect(drawer).toHaveAttribute('data-shell-session', shellSessionId('sess-alpha'));
    expect(drawer.getAttribute('data-shell-session')).not.toBe(
      agentTerminalSessionId('sess-alpha'),
    );
    expect(drawer).toHaveAttribute('data-agent-session', 'sess-alpha');
  });

  it('shows the session working dir as context', () => {
    const { getByLabelText } = render(
      <ShellDrawer {...baseProps} wsFactory={(u) => new FakeWs(u)} />,
    );
    expect(getByLabelText(/working directory/i)).toHaveTextContent('/srv/api');
  });

  it('renders a close affordance only when onClose is supplied', () => {
    const onClose = vi.fn();
    const { rerender, queryByRole, getByRole } = render(
      <ShellDrawer {...baseProps} wsFactory={(u) => new FakeWs(u)} />,
    );
    expect(queryByRole('button', { name: /close shell drawer/i })).toBeNull();
    rerender(<ShellDrawer {...baseProps} onClose={onClose} wsFactory={(u) => new FakeWs(u)} />);
    fireEvent.click(getByRole('button', { name: /close shell drawer/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
