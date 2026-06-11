import { describe, expect, it } from 'vitest';
import { OpenCodeChatAssembler } from './opencode-chat.js';

const msgUpdated = (id: string, role: string) => ({
  agentType: 'opencode',
  type: 'message.updated',
  properties: { info: { id, role } },
});
const part = (id: string, type: string, text: string, messageID: string) => ({
  agentType: 'opencode',
  type: 'message.part.updated',
  properties: { part: { id, type, text, messageID } },
});

describe('OpenCodeChatAssembler', () => {
  it('assembles user + assistant text parts with roles, skips reasoning', () => {
    const a = new OpenCodeChatAssembler();
    const s = 'sess1';
    a.observe(s, msgUpdated('u1', 'user'));
    a.observe(s, part('p1', 'text', 'hello there', 'u1'));
    a.observe(s, msgUpdated('a1', 'assistant'));
    a.observe(s, part('p2', 'reasoning', 'let me think', 'a1')); // skipped
    a.observe(s, part('p3', 'text', '', 'a1')); // empty snapshot
    a.observe(s, part('p3', 'text', 'hi back', 'a1')); // final snapshot

    expect(a.flush(s)).toEqual([
      { role: 'user', text: 'hello there' },
      { role: 'assistant', text: 'hi back' },
    ]);
    // already-emitted parts don't re-flush
    expect(a.flush(s)).toEqual([]);
  });

  it('defaults unknown-message role to assistant and isolates sessions', () => {
    const a = new OpenCodeChatAssembler();
    a.observe('x', part('p9', 'text', 'orphan', 'unknown'));
    expect(a.flush('x')).toEqual([{ role: 'assistant', text: 'orphan' }]);
    expect(a.flush('y')).toEqual([]); // different session: nothing
  });
});
