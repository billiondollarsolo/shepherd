/**
 * ChatPanel (redesign #99) — the structured conversation for a session, the
 * Synara-class workspace surface. Renders the agent's chat events (user prompts,
 * assistant messages, tool calls) from the persistent per-session event log
 * (`useSessionEvents`) as addressable bubbles, with the inline Respond bar at the
 * bottom so you can answer a blocked agent right here.
 *
 * Chat events are produced today by ACP sessions (agentd posts whole messages to
 * the hook endpoint → event log); for non-ACP agents this tab stays empty and the
 * conversation lives in the Terminal tab. As more agents stream structured
 * messages, they light up here automatically.
 */
import { Bot, MessageSquare, User, Wrench } from 'lucide-react';
import type { Session } from '@flock/shared';
import { useSessionEvents } from '../../data/queries';
import { RespondBar } from '../paddock/RespondBar';

interface ChatMessage {
  id: string;
  role: string;
  text: string;
}

/** Pull chat messages out of the raw event log (events whose payload is a chat). */
function chatMessages(
  events: ReadonlyArray<{ id: string; agentEventRaw?: unknown }>,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const e of events) {
    const raw = e.agentEventRaw as { chat?: { role?: string; text?: string } } | null;
    if (raw && raw.chat && typeof raw.chat.text === 'string' && raw.chat.text.length > 0) {
      out.push({ id: e.id, role: raw.chat.role ?? 'assistant', text: raw.chat.text });
    }
  }
  return out;
}

function Bubble({ msg }: { msg: ChatMessage }): JSX.Element {
  if (msg.role === 'tool') {
    return (
      <div className="flex items-center gap-1.5 px-1 text-2xs text-flock-ink-muted">
        <Wrench className="size-3 shrink-0" />
        <span className="truncate font-mono">{msg.text}</span>
      </div>
    );
  }
  const isUser = msg.role === 'user';
  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
          isUser
            ? 'bg-flock-accent/15 text-flock-accent'
            : 'bg-flock-surface-2 text-flock-ink-muted'
        }`}
      >
        {isUser ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
      </div>
      <div
        className={`min-w-0 max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-1.5 text-xs leading-relaxed ${
          isUser
            ? 'bg-flock-accent/15 text-flock-ink-primary'
            : 'bg-flock-surface-2 text-flock-ink-primary'
        }`}
      >
        {msg.text}
      </div>
    </div>
  );
}

export function ChatPanel({ session }: { session: Session }): JSX.Element {
  const { data: events = [] } = useSessionEvents(session.id);
  const messages = chatMessages(events);

  return (
    <div className="flex h-full min-h-0 flex-col bg-flock-bg" data-testid="chat-panel">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-flock-accent/10 text-flock-accent ring-1 ring-flock-accent/20">
              <MessageSquare className="size-6" />
            </div>
            <div>
              <h3 className="font-display text-base font-semibold text-flock-ink-primary">
                Start the conversation
              </h3>
              <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-flock-ink-muted">
                Send a prompt below to talk to the agent. Structured chat fills in for{' '}
                <span className="text-flock-ink-primary">ACP</span> sessions; other agents stream in
                the Terminal tab.
              </p>
            </div>
          </div>
        ) : (
          messages.map((m) => <Bubble key={m.id} msg={m} />)
        )}
      </div>
      <RespondBar session={session} />
    </div>
  );
}

export default ChatPanel;
