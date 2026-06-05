import { describe, expect, it } from 'vitest';
import { ptyWebSocketUrl } from '../terminal/ptyProtocol';
import { agentTerminalSessionId, shellSessionId } from './types';

describe('US-35 shell drawer — distinct-PTY invariant (spec §12.2, PRD §12.2)', () => {
  it('derives a shell PTY session id distinct from the agent terminal', () => {
    const id = 'sess-123';
    expect(shellSessionId(id)).not.toEqual(agentTerminalSessionId(id));
  });

  it('the agent terminal keeps the bare session id', () => {
    expect(agentTerminalSessionId('abc')).toBe('abc');
  });

  it('the shell PTY id is a dedicated derivative of the same session', () => {
    expect(shellSessionId('abc')).toBe('abc:shell');
    expect(shellSessionId('sess-alpha')).toBe('sess-alpha:shell');
  });

  it('distinctness holds per session, never colliding with the agent pane', () => {
    for (const id of ['a', 'b', 'long-uuid-0000', 'sess-alpha']) {
      expect(shellSessionId(id).startsWith(agentTerminalSessionId(id))).toBe(true);
      expect(shellSessionId(id)).not.toBe(agentTerminalSessionId(id));
    }
  });

  it('opens a different ws URL than the agent terminal for the same session', () => {
    const id = 'sess-alpha';
    const agentUrl = ptyWebSocketUrl(agentTerminalSessionId(id), {}, 'https://flock.test');
    const shellUrl = ptyWebSocketUrl(shellSessionId(id), {}, 'https://flock.test');
    expect(shellUrl).not.toBe(agentUrl);
    // path-based bridge route: /ws/pty/<encoded id>
    expect(agentUrl).toBe('wss://flock.test/ws/pty/sess-alpha');
    expect(shellUrl).toBe('wss://flock.test/ws/pty/sess-alpha%3Ashell');
  });
});
