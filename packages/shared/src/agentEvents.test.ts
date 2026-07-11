import { describe, expect, it } from 'vitest';
import { AgentEvent, agentEventToStatus } from './agentEvents.js';

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
  });
});
