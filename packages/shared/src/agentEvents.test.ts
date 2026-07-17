import { describe, expect, it } from 'vitest';
import { AgentEvent, AgentEventRaw, agentEventToStatus } from './agentEvents.js';

describe('AgentEvent taxonomy (F5)', () => {
  it('validates a content delta with stream kind', () => {
    const parsed = AgentEvent.parse({
      kind: 'content.delta',
      sessionId: 's1',
      streamKind: 'reasoning_text',
      text: 'thinking…',
    });
    expect(parsed.kind).toBe('content.delta');
  });

  it('rejects an unknown event kind', () => {
    expect(AgentEvent.safeParse({ kind: 'nope', sessionId: 's1' }).success).toBe(false);
  });

  it('projects every lifecycle event onto the unified Status', () => {
    const cases: Array<[Parameters<typeof agentEventToStatus>[0], string | null]> = [
      [{ kind: 'session.started', sessionId: 's' }, 'starting'],
      [{ kind: 'turn.started', sessionId: 's' }, 'running'],
      [
        { kind: 'content.delta', sessionId: 's', streamKind: 'assistant_text', text: 'x' },
        'running',
      ],
      [{ kind: 'tool.started', sessionId: 's', toolId: 't1' }, 'running'],
      [
        { kind: 'request.opened', sessionId: 's', requestId: 'r1', requestKind: 'permission' },
        'awaiting_input',
      ],
      [{ kind: 'request.resolved', sessionId: 's', requestId: 'r1' }, 'running'],
      [{ kind: 'turn.completed', sessionId: 's' }, 'idle'],
      [{ kind: 'session.ended', sessionId: 's' }, 'done'],
      [{ kind: 'error', sessionId: 's', message: 'boom' }, 'error'],
    ];
    for (const [event, expected] of cases) {
      expect(agentEventToStatus(event)).toBe(expected);
    }
  });

  it('treats usage / plan / tool.updated as telemetry-only (no status change)', () => {
    expect(
      agentEventToStatus({ kind: 'usage.updated', sessionId: 's', totalTokens: 10 }),
    ).toBeNull();
    expect(agentEventToStatus({ kind: 'plan.updated', sessionId: 's', items: [] })).toBeNull();
    expect(
      agentEventToStatus({
        kind: 'tool.updated',
        sessionId: 's',
        toolId: 't',
        status: 'completed',
      }),
    ).toBeNull();
    expect(
      agentEventToStatus({ kind: 'commands.updated', sessionId: 's', commands: ['model'] }),
    ).toBeNull();
  });
});

describe('AgentEventRaw wire shapes (hook agentEventRaw contract)', () => {
  it('validates a structured tool.started with args', () => {
    const parsed = AgentEventRaw.parse({
      kind: 'tool.started',
      toolId: 'toolu_abc',
      title: 'Write',
      toolInput: { file_path: '/x', content: 'hi' },
    });
    expect(parsed.kind).toBe('tool.started');
  });

  it('validates a tool.updated with output + structuredPatch diff', () => {
    const parsed = AgentEventRaw.parse({
      kind: 'tool.updated',
      toolId: 'toolu_abc',
      status: 'completed',
      toolOutput: 'File created…',
      toolDiff: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+hi'] }],
    });
    expect(parsed.kind).toBe('tool.updated');
  });

  it('validates a commands.updated catalog and the existing chat shape', () => {
    expect(
      AgentEventRaw.parse({ kind: 'commands.updated', commands: ['compact', 'model'] }).kind,
    ).toBe('commands.updated');
    // Backward compatible: the existing transcript path still validates.
    expect(AgentEventRaw.safeParse({ chat: { role: 'assistant', text: 'hi' } }).success).toBe(true);
  });

  it('accepts tool events with only the required fields (graceful degradation)', () => {
    expect(
      AgentEventRaw.safeParse({ kind: 'tool.started', toolId: 't', title: 'Bash' }).success,
    ).toBe(true);
    expect(
      AgentEventRaw.safeParse({ kind: 'tool.updated', toolId: 't', status: 'in_progress' }).success,
    ).toBe(true);
  });
});
