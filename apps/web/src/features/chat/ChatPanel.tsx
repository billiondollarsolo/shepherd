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
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  Bot,
  Check,
  ChevronRight,
  Copy,
  ListChecks,
  Loader2,
  Send,
  ShieldAlert,
  TriangleAlert,
  User,
  Wrench,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { Session } from '@flock/shared';
import { qk, useSessionEvents } from '../../data/queries';
import { EmptyState } from '../../components/ui';
import { Sheep } from '../../components/SheepIcon';
import { usePaddock } from '../../store/paddock';
import { LiveStatusTransitionContext, useLiveStatuses } from '../paddock/liveData';
import { RespondBar } from '../paddock/RespondBar';
import { chatTimeline, type PlanItem, type TimelineItem, type ToolStatus } from './chatTimeline';


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

type MessageItem = Extract<TimelineItem, { kind: 'message' }>;
type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;

/** Small status glyph for a tool card's lifecycle state. */
function ToolStatusIcon({ status }: { status: ToolStatus }): JSX.Element {
  if (status === 'running')
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-status-running" aria-label="running" />;
  if (status === 'success')
    return <Check className="size-3.5 shrink-0 text-status-idle" aria-label="done" />;
  if (status === 'error')
    return <TriangleAlert className="size-3.5 shrink-0 text-status-error" aria-label="error" />;
  return <Wrench className="size-3.5 shrink-0 text-flock-ink-muted" aria-label="pending" />;
}

/** A tool call rendered as a card: icon · title · status, with collapsible detail. */
function ToolCard({ item }: { item: ToolItem }): JSX.Element {
  const [open, setOpen] = useState(false);
  const hasDetail = item.detail != null && item.detail.length > 0;
  return (
    <div
      data-testid="chat-tool-card"
      className="rounded-lg border border-[var(--flock-border)] bg-flock-surface-1"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={!hasDetail}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-flock-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-flock-surface-2">
          <Wrench className="size-3 text-flock-ink-muted" />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-flock-ink-primary">
          {item.title}
        </span>
        <ToolStatusIcon status={item.status} />
        {hasDetail ? (
          <ChevronRight
            className={`size-3.5 shrink-0 text-flock-ink-muted transition-transform ${open ? 'rotate-90' : ''}`}
          />
        ) : null}
      </button>
      {open && hasDetail ? (
        <pre className="overflow-x-auto border-t border-[var(--flock-border)] px-3 py-2 font-mono text-2xs leading-relaxed text-flock-ink-primary">
          <code>{item.detail}</code>
        </pre>
      ) : null}
    </div>
  );
}

/** The agent's current plan/todo list as a compact checklist. */
function PlanCard({ items }: { items: PlanItem[] }): JSX.Element {
  return (
    <div className="rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-label text-flock-ink-muted">
        <ListChecks className="size-3.5" /> Plan
      </div>
      <ul className="space-y-0.5">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-1.5 text-xs">
            <span
              className={`mt-1 size-1.5 shrink-0 rounded-full ${
                it.status === 'completed'
                  ? 'bg-status-idle'
                  : it.status === 'in_progress'
                    ? 'bg-status-running'
                    : 'bg-flock-ink-muted/40'
              }`}
            />
            <span
              className={`min-w-0 ${it.status === 'completed' ? 'text-flock-ink-muted line-through' : 'text-flock-ink-primary'}`}
            >
              {it.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A permission/input request the agent is blocked on. Approve/Deny are
 * best-effort today (typed into the agent's stdin); a real audited approval
 * lands with the ACP request/response round-trip (plan §Phase 1).
 */
function RequestCard({ item }: { item: Extract<TimelineItem, { kind: 'request' }> }): JSX.Element {
  const respond = (text: string): void => usePaddock.getState().terminalInput?.(`${text}\r`);
  return (
    <div
      data-testid="chat-request-card"
      className="rounded-lg border border-status-awaiting/40 bg-status-awaiting/5 px-3 py-2"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-flock-ink-primary">
        <ShieldAlert className="size-3.5 shrink-0 text-status-awaiting" />
        {item.title ?? (item.requestKind === 'permission' ? 'Approval requested' : 'Input requested')}
      </div>
      {item.requestKind === 'permission' ? (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => respond('y')}
            className="rounded-md bg-flock-accent px-2.5 py-1 text-2xs font-medium text-[var(--flock-accent-foreground)] hover:bg-flock-accent-hover"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => respond('n')}
            className="rounded-md border border-[var(--flock-border-strong)] px-2.5 py-1 text-2xs font-medium text-flock-ink-primary hover:bg-flock-surface-2"
          >
            Deny
          </button>
          <span className="text-2xs text-flock-ink-muted">sent to the agent&rsquo;s input</span>
        </div>
      ) : null}
    </div>
  );
}

/** An agent error surfaced inline. */
function ErrorRow({ text }: { text: string }): JSX.Element {
  return (
    <div className="flex items-start gap-1.5 rounded-lg border border-status-error/40 bg-status-error/5 px-3 py-2 text-xs text-flock-ink-primary">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-status-error" />
      <span className="min-w-0 whitespace-pre-wrap break-words">{text}</span>
    </div>
  );
}

/** A subtle "agent is working" pulse shown while the session is running. */
function WorkingRow(): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-1 text-2xs text-flock-ink-muted" data-testid="chat-working">
      <Loader2 className="size-3.5 animate-spin" />
      <span className="animate-pulse">Agent is working…</span>
    </div>
  );
}

function Bubble({ msg, now }: { msg: MessageItem; now: number }): JSX.Element {
  // Reasoning ("thinking") is quieter than a real reply — a muted, italic aside.
  if (msg.role === 'reasoning') {
    return (
      <div className="flex gap-2 px-1 text-2xs italic text-flock-ink-muted">
        <span className="min-w-0 whitespace-pre-wrap break-words">{msg.text}</span>
      </div>
    );
  }
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

/** Route a timeline item to its renderer. */
function TimelineRow({ item, now }: { item: TimelineItem; now: number }): JSX.Element {
  switch (item.kind) {
    case 'message':
      return <Bubble msg={item} now={now} />;
    case 'tool':
      return <ToolCard item={item} />;
    case 'plan':
      return <PlanCard items={item.items} />;
    case 'request':
      return <RequestCard item={item} />;
    case 'error':
      return <ErrorRow text={item.text} />;
  }
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
  const timeline = chatTimeline(events);
  const now = Date.now();
  const liveStatus = useLiveStatuses().get(session.id) ?? session.status;
  const working = liveStatus === 'running' || liveStatus === 'starting';

  // Phase 0 live chat: a live status frame for this session (turn boundaries —
  // running → awaiting_input/done, exactly when new messages land) invalidates
  // the events (+plan) query for a near-instant update, over the status channel
  // that's already open. Reuses the existing transport; no new one needed yet.
  const queryClient = useQueryClient();
  const lastTransition = useContext(LiveStatusTransitionContext).get(session.id);
  useEffect(() => {
    if (lastTransition == null) return;
    void queryClient.invalidateQueries({ queryKey: qk.events(session.id) });
    void queryClient.invalidateQueries({ queryKey: qk.plan(session.id) });
  }, [lastTransition, session.id, queryClient]);

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
  }, [timeline.length, working]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-flock-bg" data-testid="chat-panel">
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full space-y-3 overflow-y-auto p-3"
        >
          {timeline.length === 0 && !working ? (
            <div className="flex h-full items-center justify-center">
              <EmptyState
                icon={<Sheep className="text-flock-ink-muted" />}
                title="Start the conversation"
                description="Send a prompt below to talk to the agent. Structured chat fills in for ACP sessions; other agents stream in the Terminal tab."
              />
            </div>
          ) : (
            <>
              {timeline.map((item) => (
                <TimelineRow key={item.id} item={item} now={now} />
              ))}
              {working ? <WorkingRow /> : null}
            </>
          )}
        </div>

        {!pinned && timeline.length > 0 ? (
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
