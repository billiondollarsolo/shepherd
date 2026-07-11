/**
 * OpenCodeChatAssembler — turns OpenCode's streamed message PARTS into whole Chat
 * messages for the structured Chat tab.
 *
 * OpenCode (unlike claude/codex with a transcript, or gemini/grok over ACP) emits
 * its conversation on its event bus: `message.updated` carries only METADATA
 * (id/role/model/tokens — NO text), while the text streams as `message.part.updated`
 * snapshots (`part = {id, type:'text'|'reasoning'|..., text, messageID}`). So we:
 *   - learn messageId → role from `message.updated`,
 *   - keep the latest text of every `type:'text'` part,
 *   - and on `session.idle` (turn end) flush the un-emitted text parts, each
 *     labelled with its message's role, in arrival order.
 *
 * State is per Flock session id; call forget() when the session ends. Reasoning /
 * step-* parts are ignored (not conversation).
 */

export interface AssembledChat {
  role: string; // user | assistant
  text: string;
}

interface SessionState {
  roles: Map<string, string>; // messageId -> role
  parts: Map<string, { msgId: string; text: string; seq: number }>; // partId -> latest snapshot
  emitted: Set<string>; // partIds already flushed
  seq: number;
}

export class OpenCodeChatAssembler {
  private readonly sessions = new Map<string, SessionState>();

  private state(id: string): SessionState {
    let s = this.sessions.get(id);
    if (!s) {
      s = { roles: new Map(), parts: new Map(), emitted: new Set(), seq: 0 };
      this.sessions.set(id, s);
    }
    return s;
  }

  /** Record role + part text from one OpenCode event body. Safe on any shape. */
  observe(sessionId: string, body: unknown): void {
    const e = body as { type?: string; properties?: Record<string, unknown> } | null;
    if (!e || typeof e.type !== 'string') return;
    const props = (e.properties ?? {}) as Record<string, unknown>;
    if (e.type === 'message.updated') {
      const info = props.info as { id?: string; role?: string } | undefined;
      if (info?.id && typeof info.role === 'string')
        this.state(sessionId).roles.set(info.id, info.role);
    } else if (e.type === 'message.part.updated') {
      const part = props.part as
        | { id?: string; type?: string; text?: string; messageID?: string }
        | undefined;
      if (part?.id && part.type === 'text' && typeof part.text === 'string') {
        const st = this.state(sessionId);
        const prev = st.parts.get(part.id);
        st.parts.set(part.id, {
          msgId: part.messageID ?? prev?.msgId ?? '',
          text: part.text,
          seq: prev?.seq ?? st.seq++,
        });
      }
    }
  }

  /** On turn end: the new (un-emitted) text parts as ordered chat messages. */
  flush(sessionId: string): AssembledChat[] {
    const st = this.sessions.get(sessionId);
    if (!st) return [];
    const out: Array<{ role: string; text: string; seq: number }> = [];
    for (const [partId, p] of st.parts) {
      if (st.emitted.has(partId) || p.text.trim().length === 0) continue;
      st.emitted.add(partId);
      out.push({ role: st.roles.get(p.msgId) ?? 'assistant', text: p.text, seq: p.seq });
    }
    out.sort((a, b) => a.seq - b.seq);
    return out.map(({ role, text }) => ({ role, text }));
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
