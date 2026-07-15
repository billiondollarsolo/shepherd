/**
 * ChatPanel (redesign #99) — the structured conversation for a session, the
 * Synara-class workspace surface. Renders the agent's chat events (user prompts,
 * assistant messages, tool calls) from the persistent per-session event log
 * (`useSessionEvents`) as addressable bubbles, with an always-present composer at
 * the bottom so you can talk to the agent from here — and the inline RespondBar
 * quick-actions layered on top when the agent is actually blocked.
 *
 * Chat events are produced today by ACP sessions (agentd posts whole messages to
 * the hook endpoint → event log); for non-ACP agents this tab stays empty and the
 * conversation lives in the Terminal tab. As more agents stream structured
 * messages, they light up here automatically.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, Bot, ChevronRight, Copy, Send, User, Wrench } from 'lucide-react';
import type { Session } from '@flock/shared';
import { useSessionEvents } from '../../data/queries';
import { EmptyState } from '../../components/ui';
import { Sheep } from '../../components/SheepIcon';
import { usePaddock } from '../../store/paddock';
import { RespondBar } from '../paddock/RespondBar';

interface ChatMessage {
  id: string;
  role: string;
  text: string;
  ts?: string;
}

/** Pull chat messages out of the raw event log (events whose payload is a chat). */
function chatMessages(
  events: ReadonlyArray<{ id: string; ts?: string; agentEventRaw?: unknown }>,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const e of events) {
    const raw = e.agentEventRaw as { chat?: { role?: string; text?: string } } | null;
    if (raw && raw.chat && typeof raw.chat.text === 'string' && raw.chat.text.length > 0) {
      out.push({ id: e.id, role: raw.chat.role ?? 'assistant', text: raw.chat.text, ts: e.ts });
    }
  }
  return out;
}

/** Compact relative time: "now", "3m", "2h", "4d". Pure. */
export function chatTimeAgo(iso: string, now: number): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export type ChatSegment =
  | { type: 'code'; lang: string; content: string }
  | { type: 'text'; content: string };

/**
 * Split a message into fenced-code and plain-text segments. Pure — the block-level
 * markdown parser is unit-tested directly. Inline spans (`code`, **bold**) are
 * rendered from the text segments by {@link renderInline}.
 */
export function parseMessage(text: string): ChatSegment[] {
  const segments: ChatSegment[] = [];
  // ```lang\n …code… ``` — lang is optional, body is non-greedy across newlines.
  const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > last) {
      const pre = text.slice(last, m.index);
      if (pre.length > 0) segments.push({ type: 'text', content: pre });
    }
    segments.push({
      type: 'code',
      lang: (m[1] ?? '').trim(),
      content: (m[2] ?? '').replace(/\n$/, ''),
    });
    last = fence.lastIndex;
  }
  if (last < text.length) {
    const rest = text.slice(last);
    if (rest.length > 0) segments.push({ type: 'text', content: rest });
  }
  if (segments.length === 0) segments.push({ type: 'text', content: text });
  return segments;
}

/** Render inline `code` and **bold** spans inside a text segment. */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      nodes.push(
        <code
          key={key++}
          className="rounded-sm bg-flock-surface-2 px-1 font-mono text-flock-ink-primary"
        >
          {m[1]}
        </code>,
      );
    } else {
      nodes.push(
        <strong key={key++} className="font-semibold text-flock-ink-primary">
          {m[2]}
        </strong>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** A fenced code block: mono on surface-2 with a copy button. */
function CodeBlock({ lang, content }: { lang: string; content: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="group/code relative my-1 overflow-hidden rounded-md border border-[var(--flock-border)] bg-flock-surface-2">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--flock-border)] px-2.5 py-1">
        <span className="font-mono text-2xs text-flock-ink-muted">{lang || 'code'}</span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy code"
          className="flex items-center gap-1 rounded-xs px-1 py-0.5 text-2xs text-flock-ink-muted transition-colors hover:bg-flock-surface-1 hover:text-flock-ink-primary"
        >
          <Copy className="size-3" />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-2xs leading-relaxed text-flock-ink-primary">
        <code>{content}</code>
      </pre>
    </div>
  );
}

/** Assistant message body — routed through the lightweight markdown formatter. */
function MessageBody({ text }: { text: string }): JSX.Element {
  const segments = parseMessage(text);
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'code' ? (
          <CodeBlock key={i} lang={seg.lang} content={seg.content} />
        ) : (
          <span key={i} className="whitespace-pre-wrap break-words">
            {renderInline(seg.content)}
          </span>
        ),
      )}
    </>
  );
}

/** Expandable tool-call row — shows the first line, expands to the full payload. */
function ToolRow({ msg }: { msg: ChatMessage }): JSX.Element {
  const [open, setOpen] = useState(false);
  const firstLine = msg.text.split('\n', 1)[0] ?? msg.text;
  const hasMore = msg.text.length > firstLine.length;
  return (
    <div className="px-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={!hasMore}
        className="flex w-full min-w-0 items-center gap-1.5 rounded py-0.5 text-left text-2xs text-flock-ink-muted hover:text-flock-ink-primary disabled:cursor-default"
      >
        <ChevronRight
          className={`size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''} ${
            hasMore ? '' : 'opacity-0'
          }`}
        />
        <Wrench className="size-3 shrink-0" />
        <span className="truncate font-mono">{firstLine}</span>
      </button>
      {open && hasMore ? (
        <pre className="ml-[1.375rem] mt-0.5 overflow-x-auto rounded-md border border-[var(--flock-border)] bg-flock-surface-2 px-3 py-2 font-mono text-2xs leading-relaxed text-flock-ink-primary">
          <code>{msg.text}</code>
        </pre>
      ) : null}
    </div>
  );
}

function Bubble({ msg, now }: { msg: ChatMessage; now: number }): JSX.Element {
  if (msg.role === 'tool') return <ToolRow msg={msg} />;

  const isUser = msg.role === 'user';
  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
          isUser ? 'bg-flock-accent/15 text-flock-accent' : 'bg-flock-surface-2 text-flock-ink-muted'
        }`}
      >
        {isUser ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
      </div>
      <div className={`flex min-w-0 max-w-[85%] flex-col gap-0.5 ${isUser ? 'items-end' : ''}`}>
        <div
          className={`min-w-0 rounded-lg px-3 py-1.5 text-xs leading-relaxed ${
            isUser
              ? 'whitespace-pre-wrap break-words bg-flock-accent/15 text-flock-ink-primary'
              : 'bg-flock-surface-2 text-flock-ink-primary'
          }`}
        >
          {isUser ? msg.text : <MessageBody text={msg.text} />}
        </div>
        {msg.ts ? (
          <time className="px-1 text-2xs tabular-nums text-flock-ink-muted/70">
            {chatTimeAgo(msg.ts, now)}
          </time>
        ) : null}
      </div>
    </div>
  );
}

/** The always-present composer — types a prompt into the agent's PTY (as stdin). */
function Composer(): JSX.Element {
  const [draft, setDraft] = useState('');
  const send = (): void => {
    const text = draft.trim();
    if (text.length === 0) return;
    usePaddock.getState().terminalInput?.(`${text}\r`);
    setDraft('');
  };
  return (
    <div className="flex items-end gap-2 border-t border-[var(--flock-border)] bg-flock-surface-1 p-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        rows={1}
        placeholder="Send a prompt to the agent…"
        data-testid="chat-composer"
        className="max-h-32 min-h-[2rem] min-w-0 flex-1 resize-none rounded-md border border-[var(--flock-border)] bg-flock-surface-0 px-2.5 py-1.5 text-xs text-flock-ink-primary outline-none placeholder:text-flock-ink-muted focus:border-flock-accent"
      />
      <button
        type="button"
        onClick={send}
        disabled={draft.trim().length === 0}
        aria-label="Send prompt"
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-flock-accent text-[var(--flock-accent-foreground)] transition-opacity hover:bg-flock-accent-hover disabled:opacity-40"
      >
        <Send className="size-4" />
      </button>
    </div>
  );
}

export function ChatPanel({ session }: { session: Session }): JSX.Element {
  const { data: events = [] } = useSessionEvents(session.id);
  const messages = chatMessages(events);
  const now = Date.now();

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    pinnedRef.current = atBottom;
    setPinned(atBottom);
  };

  const scrollToBottom = (): void => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // Auto-scroll to the latest message — but only while the user is pinned to the
  // bottom, so reading back through history isn't yanked away on every new event.
  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-flock-bg" data-testid="chat-panel">
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full space-y-3 overflow-y-auto p-3"
        >
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <EmptyState
                icon={<Sheep className="text-flock-ink-muted" />}
                title="Start the conversation"
                description="Send a prompt below to talk to the agent. Structured chat fills in for ACP sessions; other agents stream in the Terminal tab."
              />
            </div>
          ) : (
            messages.map((m) => <Bubble key={m.id} msg={m} now={now} />)
          )}
        </div>

        {!pinned && messages.length > 0 ? (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Jump to latest"
            className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--flock-border)] bg-flock-surface-2 px-2.5 py-1 text-2xs text-flock-ink-muted shadow-sm transition-colors hover:text-flock-ink-primary"
          >
            <ArrowDown className="size-3" /> Latest
          </button>
        ) : null}
      </div>

      <RespondBar session={session} />
      <Composer />
    </div>
  );
}
