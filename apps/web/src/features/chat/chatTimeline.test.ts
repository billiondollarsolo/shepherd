import { describe, expect, it } from 'vitest';
import { chatTimeline, pendingRequest, toolTitle } from './chatTimeline';

const ev = (id: string, agentEventRaw: unknown, ts?: string) => ({ id, agentEventRaw, ts });

describe('toolTitle', () => {
  it('splits "verb target" into a "Verb · target" title', () => {
    expect(toolTitle('edit auth.ts')).toEqual({ title: 'Edit · auth.ts', detail: undefined });
  });
  it('keeps the trailing lines as detail', () => {
    expect(toolTitle('run npm test\n+ 42 passing')).toEqual({
      title: 'Run · npm test',
      detail: '+ 42 passing',
    });
  });
});

describe('chatTimeline — current transcript shape', () => {
  it('maps user/assistant to messages and tool to a tool card', () => {
    const t = chatTimeline([
      ev('a', { chat: { role: 'user', text: 'build JWT auth' } }),
      ev('b', { chat: { role: 'assistant', text: 'On it.' } }),
      ev('c', { chat: { role: 'tool', text: 'edit auth.ts' } }),
      ev('d', { chat: { role: 'assistant', text: '' } }), // empty → dropped
      ev('e', { mappedStatus: 'running' }), // not chat → ignored
    ]);
    expect(t.map((i) => i.kind)).toEqual(['message', 'message', 'tool']);
    expect(t[2]).toMatchObject({ kind: 'tool', title: 'Edit · auth.ts', status: 'success' });
  });
});

describe('chatTimeline — F5 structured union', () => {
  it('merges tool.started/updated by toolId and tracks status', () => {
    const t = chatTimeline([
      ev('1', { kind: 'tool.started', toolId: 'T1', title: 'Edit auth.ts' }),
      ev('2', { kind: 'tool.updated', toolId: 'T1', status: 'completed' }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: 'tool', title: 'Edit auth.ts', status: 'success' });
  });

  it('keeps only the latest plan snapshot', () => {
    const t = chatTimeline([
      ev('1', { kind: 'plan.updated', items: [{ text: 'a', status: 'pending' }] }),
      ev('2', { kind: 'plan.updated', items: [{ text: 'a', status: 'completed' }] }),
    ]);
    const plans = t.filter((i) => i.kind === 'plan');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ items: [{ text: 'a', status: 'completed' }] });
  });

  it('tracks request open → resolved and surfaces the pending one', () => {
    const open = chatTimeline([ev('1', { kind: 'request.opened', requestId: 'R1', requestKind: 'permission', title: 'Run rm -rf?' })]);
    expect(pendingRequest(open)).toMatchObject({ kind: 'request', title: 'Run rm -rf?', resolved: false });
    const resolved = chatTimeline([
      ev('1', { kind: 'request.opened', requestId: 'R1', requestKind: 'permission' }),
      ev('2', { kind: 'request.resolved', requestId: 'R1' }),
    ]);
    expect(pendingRequest(resolved)).toBeNull();
  });

  it('maps content.delta stream kinds to message roles', () => {
    const t = chatTimeline([
      ev('1', { kind: 'content.delta', streamKind: 'assistant_text', text: 'hello' }),
      ev('2', { kind: 'content.delta', streamKind: 'reasoning_text', text: 'thinking' }),
    ]);
    expect(t.map((i) => (i.kind === 'message' ? i.role : i.kind))).toEqual(['assistant', 'reasoning']);
  });
});
