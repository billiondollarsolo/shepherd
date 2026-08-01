import { describe, expect, it } from 'vitest';
import {
  isChatMode,
  mapScreenStateToWire,
  mergeStatusAuthority,
} from './status-authority.js';

describe('isChatMode', () => {
  it('recognizes structured Chat transports', () => {
    for (const m of ['chat', 'claude-stream', 'codex-app-server', 'acp']) {
      expect(isChatMode(m)).toBe(true);
    }
    expect(isChatMode('ACP')).toBe(true);
    expect(isChatMode(' Claude-Stream ')).toBe(true);
  });

  it('treats terminal / empty as non-chat', () => {
    expect(isChatMode('terminal')).toBe(false);
    expect(isChatMode('pty')).toBe(false);
    expect(isChatMode('')).toBe(false);
    expect(isChatMode(null)).toBe(false);
    expect(isChatMode(undefined)).toBe(false);
  });
});

describe('mapScreenStateToWire', () => {
  it('maps Herdr screen vocab to wire', () => {
    expect(mapScreenStateToWire('working')).toBe('running');
    expect(mapScreenStateToWire('blocked')).toBe('awaiting_input');
    expect(mapScreenStateToWire('idle')).toBe('idle');
    expect(mapScreenStateToWire('unknown')).toBeNull();
  });
});

describe('mergeStatusAuthority', () => {
  it('Chat mode: transport wins; never applies screen blocker (D11)', () => {
    const d = mergeStatusAuthority({
      mode: 'chat',
      screenDetectOn: true,
      transportState: 'running',
      screenState: 'blocked',
      screenVisibleBlocker: true,
    });
    expect(d.state).toBe('running');
    expect(d.source).toBe('transport');
    expect(d.reason).toBe('chat_mode_transport_authority');
  });

  it('Chat mode: claude-stream / acp also ignore screen', () => {
    for (const mode of ['claude-stream', 'codex-app-server', 'acp']) {
      const d = mergeStatusAuthority({
        mode,
        screenDetectOn: true,
        transportState: 'idle',
        screenState: 'blocked',
        screenVisibleBlocker: true,
      });
      expect(d.state).toBe('idle');
      expect(d.source).toBe('transport');
    }
  });

  it('Terminal: visible blocker → awaiting_input over idle transcript (D4)', () => {
    const d = mergeStatusAuthority({
      mode: 'terminal',
      screenDetectOn: true,
      transcriptState: 'idle',
      screenState: 'blocked',
      screenVisibleBlocker: true,
    });
    expect(d.state).toBe('awaiting_input');
    expect(d.source).toBe('screen');
    expect(d.reason).toBe('visible_blocker_or_blocked');
  });

  it('Terminal: lifecycle authority skips screen', () => {
    const d = mergeStatusAuthority({
      mode: 'terminal',
      screenDetectOn: true,
      lifecycleActive: true,
      lifecycleState: 'running',
      screenState: 'blocked',
      screenVisibleBlocker: true,
    });
    expect(d.state).toBe('running');
    expect(d.source).toBe('lifecycle');
    expect(d.reason).toBe('lifecycle_authority_active');
  });

  it('default screendetect off: screen ignored (D10)', () => {
    const d = mergeStatusAuthority({
      mode: 'terminal',
      screenDetectOn: false,
      transcriptState: 'idle',
      screenState: 'blocked',
      screenVisibleBlocker: true,
    });
    expect(d.state).toBe('idle');
    expect(d.source).toBe('transcript');
  });

  it('screenDetectOn omitted defaults to off', () => {
    const d = mergeStatusAuthority({
      mode: 'terminal',
      screenState: 'blocked',
      screenVisibleBlocker: true,
      current: 'running',
    });
    // No screen, no other signals → hold current
    expect(d.state).toBe('running');
    expect(d.source).toBe('current');
  });

  it('skip_state_update does not apply screen', () => {
    const d = mergeStatusAuthority({
      mode: 'terminal',
      screenDetectOn: true,
      screenSkip: true,
      current: 'running',
      screenState: 'idle',
    });
    expect(d.state).toBe('running');
    expect(d.source).not.toBe('screen');
  });

  it('activity and idle fallback', () => {
    expect(
      mergeStatusAuthority({
        mode: 'terminal',
        activityState: 'running',
      }),
    ).toMatchObject({ state: 'running', source: 'activity' });

    expect(
      mergeStatusAuthority({
        mode: 'terminal',
      }),
    ).toMatchObject({ state: 'idle', source: 'default', reason: 'idle_fallback' });
  });
});
