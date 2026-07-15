import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Session } from '@flock/shared';

let EVENTS: Array<{ id: string; agentEventRaw: unknown }> = [];
vi.mock('../../data/queries', () => ({ useSessionEvents: () => ({ data: EVENTS }) }));
vi.mock('../paddock/liveData', () => ({ useLiveStatuses: () => new Map() }));

import { ChatPanel, parseMessage, chatTimeAgo } from './ChatPanel';

const session = { id: 's1', status: 'idle' } as unknown as Session;

describe('ChatPanel (redesign #99 — structured conversation)', () => {
  it('renders chat events as messages and ignores non-chat events', () => {
    EVENTS = [
      { id: 'e1', agentEventRaw: { chat: { role: 'user', text: 'build JWT auth' } } },
      { id: 'e2', agentEventRaw: { chat: { role: 'assistant', text: 'On it.' } } },
      { id: 'e3', agentEventRaw: { chat: { role: 'tool', text: 'edit auth.ts' } } },
      { id: 'e4', agentEventRaw: { mappedStatus: 'running' } }, // not a chat → ignored
      { id: 'e5', agentEventRaw: null },
    ];
    render(<ChatPanel session={session} />);
    expect(screen.getByText('build JWT auth')).toBeTruthy();
    expect(screen.getByText('On it.')).toBeTruthy();
    expect(screen.getByText('edit auth.ts')).toBeTruthy();
  });

  it('shows an empty state when there are no chat events', () => {
    EVENTS = [{ id: 'e1', agentEventRaw: { mappedStatus: 'idle' } }];
    render(<ChatPanel session={session} />);
    expect(screen.getByText(/Start the conversation/i)).toBeTruthy();
  });

  it('always renders a composer, even with no chat events', () => {
    EVENTS = [];
    render(<ChatPanel session={session} />);
    expect(screen.getByTestId('chat-composer')).toBeTruthy();
  });
});

describe('parseMessage (lightweight markdown formatter)', () => {
  it('returns a single text segment for plain prose', () => {
    expect(parseMessage('just some text')).toEqual([{ type: 'text', content: 'just some text' }]);
  });

  it('extracts a fenced code block with its language and trims the trailing newline', () => {
    const segs = parseMessage('before\n```ts\nconst x = 1;\n```\nafter');
    expect(segs).toEqual([
      { type: 'text', content: 'before\n' },
      { type: 'code', lang: 'ts', content: 'const x = 1;' },
      { type: 'text', content: '\nafter' },
    ]);
  });

  it('handles a fence with no language label', () => {
    const segs = parseMessage('```\nraw\n```');
    expect(segs).toEqual([{ type: 'code', lang: '', content: 'raw' }]);
  });

  it('handles multiple fenced blocks', () => {
    const segs = parseMessage('```\na\n```\nmid\n```\nb\n```');
    expect(segs.filter((s) => s.type === 'code')).toHaveLength(2);
    expect(segs.some((s) => s.type === 'text' && s.content.includes('mid'))).toBe(true);
  });

  it('never returns an empty segment list', () => {
    expect(parseMessage('')).toEqual([{ type: 'text', content: '' }]);
  });
});

describe('chatTimeAgo', () => {
  const now = new Date('2026-07-15T12:00:00Z').getTime();
  it('reads recent events as "now"', () => {
    expect(chatTimeAgo('2026-07-15T11:59:30Z', now)).toBe('now');
  });
  it('formats minutes, hours, and days', () => {
    expect(chatTimeAgo('2026-07-15T11:57:00Z', now)).toBe('3m');
    expect(chatTimeAgo('2026-07-15T10:00:00Z', now)).toBe('2h');
    expect(chatTimeAgo('2026-07-11T12:00:00Z', now)).toBe('4d');
  });
});
