import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@flock/shared';

let EVENTS: Array<{ id: string; agentEventRaw: unknown }> = [];
let MODELS: string[] = [];
const relaunchMutate = vi.fn();
vi.mock('../../data/queries', () => ({
  useSessionEvents: () => ({ data: EVENTS }),
  useAgentModels: () => ({ data: { models: MODELS, source: 'static' } }),
  useRelaunchSession: () => ({ mutate: relaunchMutate, isPending: false }),
  qk: {
    events: (id: string) => ['events', id],
    plan: (id: string) => ['plan', id],
  },
}));
vi.mock('../paddock/liveData', async () => {
  const { createContext } = await import('react');
  return {
    useLiveStatuses: () => new Map(),
    LiveStatusTransitionContext: createContext<ReadonlyMap<string, number>>(new Map()),
  };
});

import { TooltipProvider } from '../../components/ui';
import { ChatPanel, parseMessage, chatTimeAgo, resolveSlashCommands } from './ChatPanel';

const session = { id: 's1', status: 'idle' } as unknown as Session;

/** A chat-capable session (claude-code) with a workspace, for the composer controls. */
const chatSession = {
  id: 's2',
  status: 'running',
  agentType: 'claude-code',
  nodeId: 'n1',
  workingDir: '/work',
  model: null,
} as unknown as Session;

/** ChatPanel now uses the query client (Phase 0 live invalidation), so render under one. */
function renderPanel(s: Session = session): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <ChatPanel session={s} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('ChatPanel (redesign #99 — structured conversation)', () => {
  it('renders chat events as messages and ignores non-chat events', () => {
    EVENTS = [
      { id: 'e1', agentEventRaw: { chat: { role: 'user', text: 'build JWT auth' } } },
      { id: 'e2', agentEventRaw: { chat: { role: 'assistant', text: 'On it.' } } },
      { id: 'e3', agentEventRaw: { chat: { role: 'tool', text: 'edit auth.ts' } } },
      { id: 'e4', agentEventRaw: { mappedStatus: 'running' } }, // not a chat → ignored
      { id: 'e5', agentEventRaw: null },
    ];
    renderPanel();
    expect(screen.getByText('build JWT auth')).toBeTruthy();
    expect(screen.getByText('On it.')).toBeTruthy();
    // Tool events now render as a structured tool card ("Verb · target").
    expect(screen.getByTestId('chat-tool-card')).toHaveTextContent('Edit · auth.ts');
  });

  it('renders a structured tool card with an args summary and an expandable diff', () => {
    // The events API returns newest-first; ChatPanel reverses to chronological.
    EVENTS = [
      {
        id: 'e2',
        agentEventRaw: {
          kind: 'tool.updated',
          toolId: 'T1',
          status: 'completed',
          toolDiff: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+hi'] }],
        },
      },
      {
        id: 'e1',
        agentEventRaw: {
          kind: 'tool.started',
          toolId: 'T1',
          title: 'Write',
          toolInput: { file_path: '/x', content: 'hi' },
        },
      },
    ];
    renderPanel();
    const card = screen.getByTestId('chat-tool-card');
    expect(card).toHaveTextContent('Write');
    // The args summary (file_path) is shown inline next to the title.
    expect(screen.getByTestId('chat-tool-input')).toHaveTextContent('/x');
    // The diff is collapsed until the card is expanded.
    expect(screen.queryByTestId('chat-tool-diff')).toBeNull();
    fireEvent.click(card.querySelector('button')!);
    expect(screen.getByTestId('chat-tool-diff')).toHaveTextContent('+hi');
  });

  it('shows an empty state when there are no chat events', () => {
    EVENTS = [{ id: 'e1', agentEventRaw: { mappedStatus: 'idle' } }];
    renderPanel();
    expect(screen.getByText(/Start the conversation/i)).toBeTruthy();
  });

  it('always renders a composer, even with no chat events', () => {
    EVENTS = [];
    renderPanel();
    expect(screen.getByTestId('chat-composer')).toBeTruthy();
  });

  it('renders a permission approval card naming the tool + args, then greys it on resolve', () => {
    // request.opened carries the tool name (title) + raw tool input; Approve/Deny type
    // y/n into stdin (agentd consumes it as the control_response). request.resolved greys it.
    EVENTS = [
      {
        id: 'e1',
        agentEventRaw: {
          kind: 'request.opened',
          requestId: 'R1',
          requestKind: 'permission',
          title: 'Write',
          toolInput: { file_path: '/etc/hosts', content: 'x' },
        },
      },
    ];
    const { rerender } = renderPanel();
    const card = screen.getByTestId('chat-request-card');
    expect(card).toHaveTextContent('Approve Write');
    expect(screen.getByTestId('chat-request-input')).toHaveTextContent('/etc/hosts');
    expect(screen.getByText('Approve')).toBeTruthy();
    expect(screen.getByText('Deny')).toBeTruthy();
    expect(card.getAttribute('data-resolved')).toBe('false');

    // A following request.resolved marks the card resolved (buttons gone). The events
    // API returns newest-first (ChatPanel reverses to chronological), so the resolve
    // (newer) is prepended ahead of the open.
    EVENTS = [
      { id: 'e2', agentEventRaw: { kind: 'request.resolved', requestId: 'R1' } },
      ...EVENTS,
    ];
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ChatPanel session={session} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const resolved = screen.getByTestId('chat-request-card');
    expect(resolved.getAttribute('data-resolved')).toBe('true');
    expect(screen.queryByText('Approve')).toBeNull();
  });
});

describe('ChatPanel composer controls (Phases B/C/D)', () => {
  it('renders the model switcher for a chat-capable agent with models', () => {
    EVENTS = [];
    MODELS = ['Claude Opus 4.6', 'Claude Sonnet 4.6'];
    renderPanel(chatSession);
    expect(screen.getByTestId('chat-model-switcher')).toBeTruthy();
  });

  it('hides the model switcher when no models are reported', () => {
    EVENTS = [];
    MODELS = [];
    renderPanel(chatSession);
    expect(screen.queryByTestId('chat-model-switcher')).toBeNull();
  });

  it('renders the slash-command menu for an agent with a catalog', () => {
    EVENTS = [];
    MODELS = [];
    renderPanel(chatSession);
    expect(screen.getByTestId('chat-slash-menu')).toBeTruthy();
  });

  it('renders the attach (image upload) button', () => {
    EVENTS = [];
    MODELS = [];
    renderPanel(chatSession);
    expect(screen.getByTestId('chat-attach')).toBeTruthy();
  });

  it('keeps the slash menu present when the session streams a dynamic catalog', () => {
    EVENTS = [
      {
        id: 'e1',
        agentEventRaw: { kind: 'commands.updated', commands: ['compact', 'context', 'model'] },
      },
    ];
    MODELS = [];
    renderPanel(chatSession);
    expect(screen.getByTestId('chat-slash-menu')).toBeTruthy();
  });
});

describe('resolveSlashCommands (dynamic slash catalog)', () => {
  it('prefers the live commands, normalizing bare names to "/name"', () => {
    expect(resolveSlashCommands('claude-code', ['compact', '/context', 'model'])).toEqual([
      '/compact',
      '/context',
      '/model',
    ]);
  });
  it('falls back to the static per-agent catalog when no live commands have arrived', () => {
    const fallback = resolveSlashCommands('claude-code', null);
    expect(fallback).toContain('/clear');
    expect(resolveSlashCommands('claude-code', [])).toBe(fallback);
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
