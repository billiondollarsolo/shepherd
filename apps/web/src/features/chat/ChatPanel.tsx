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
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import hljs from 'highlight.js/lib/common';
import {
  ArrowDown,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderGit2,
  ListChecks,
  Loader2,
  Paperclip,
  Plus,
  Send,
  Shield,
  ShieldAlert,
  Slash,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { AgentType, Session, SessionPermissionMode } from '@flock/shared';
import {
  permissionModesForAgent,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODE_SHORT,
} from './permissionModes';
import { qk, useAgentModels, useRelaunchSession, useSessionEvents } from '../../data/queries';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  toast,
} from '../../components/ui';
import { makeNodeDir, writeNodeFile } from '../../data/treeApi';
import { Sheep } from '../../components/SheepIcon';
import { usePaddock } from '../../store/paddock';
import { LiveStatusTransitionContext, useLiveStatuses } from '../paddock/liveData';
import { RespondBar } from '../paddock/RespondBar';
import { isChatCapable } from './chatCapable';
import {
  chatTimeline,
  latestCommands,
  type DiffHunk,
  type PlanItem,
  type TimelineItem,
  type ToolStatus,
} from './chatTimeline';

/**
 * Type text into a session's PTY stdin. Prefers the session's OWN per-session writer
 * (registered by every mounted terminal → works for any tile in the multi-agent
 * grid), falling back to the global focused-terminal seam for older single-view
 * paths. No-op if neither is available (terminal not mounted).
 */
function typeToSession(sessionId: string, text: string): void {
  const s = usePaddock.getState();
  (s.sessionInputs[sessionId] ?? s.terminalInput)?.(text);
}

/**
 * Per-agent catalog of slash commands for the composer's quick "/" menu — the common
 * built-ins for that CLI, typed verbatim into its PTY stdin. Not exhaustive (custom
 * project/plugin commands still work by typing them), and session-disruptive ones
 * (/login, /logout, /quit) are deliberately omitted. An empty list hides the button.
 */
const SLASH_COMMANDS: Partial<Record<AgentType, readonly string[]>> = {
  'claude-code': [
    '/clear',
    '/compact',
    '/context',
    '/cost',
    '/model',
    '/config',
    '/memory',
    '/agents',
    '/mcp',
    '/permissions',
    '/review',
    '/pr-comments',
    '/status',
    '/doctor',
    '/init',
    '/resume',
    '/vim',
    '/add-dir',
    '/terminal-setup',
    '/release-notes',
    '/bug',
    '/help',
  ],
  codex: [
    '/model',
    '/approvals',
    '/new',
    '/diff',
    '/mention',
    '/status',
    '/mcp',
    '/init',
    '/compact',
    '/review',
  ],
  antigravity: ['/help'],
};

/**
 * Agents whose CLI resumes the most-recent conversation on relaunch (they have
 * `resumeArgs` in the orchestrator's AGENT_CAPS). For everyone else a model switch
 * restarts the agent as a FRESH conversation — the switcher copy must say so rather
 * than promise a resume it won't deliver.
 */
const RESUMES_ON_RELAUNCH: ReadonlySet<AgentType> = new Set<AgentType>([
  'claude-code',
  'antigravity',
]);

/** ~4MB client cap (the server caps at 5MB); keeps a friendly error before the wire. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Read a File as base64 (no `data:` prefix), for the node file-write endpoint. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
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
          className="rounded border border-[var(--flock-border)] bg-flock-surface-2 px-1.5 py-0.5 font-mono text-[0.92em] text-flock-ink-primary"
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

/** A small ghost copy button (Copy → Check), for code blocks and messages. */
function CopyButton({
  text,
  label = 'Copy',
  showLabel = true,
  className = '',
}: {
  text: string;
  label?: string;
  showLabel?: boolean;
  className?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      className={`flex items-center gap-1 rounded-xs px-1 py-0.5 text-2xs text-flock-ink-muted transition-colors hover:bg-flock-surface-1 hover:text-flock-ink-primary ${className}`}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {showLabel ? (copied ? 'Copied' : label) : null}
    </button>
  );
}

/** A fenced code block: syntax-highlighted (highlight.js, themed to the terminal's
 *  Atom One ANSI palette so it flips with the theme) with a lang label + copy. */
function CodeBlock({ lang, content }: { lang: string; content: string }): JSX.Element {
  // Highlight to HTML: honor the fence language when known, else auto-detect. The
  // result is trusted markup from highlight.js (escapes the source), rendered into
  // a .hljs container whose token colours map to --flock-term-ansi-* in index.css.
  const html = useMemo<string | null>(() => {
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
      }
      return hljs.highlightAuto(content).value;
    } catch {
      return null;
    }
  }, [lang, content]);
  return (
    <div className="group/code relative my-1 overflow-hidden rounded-md border border-[var(--flock-border)] bg-flock-surface-2">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--flock-border)] px-2.5 py-1">
        <span className="font-mono text-2xs text-flock-ink-muted">{lang || 'code'}</span>
        <CopyButton text={content} label="Copy" className="hover:!bg-flock-surface-1" />
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-2xs leading-relaxed text-flock-ink-primary">
        {html != null ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code>{content}</code>
        )}
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
    return (
      <Loader2
        className="size-3.5 shrink-0 animate-spin text-status-running"
        aria-label="running"
      />
    );
  if (status === 'success')
    return <Check className="size-3.5 shrink-0 text-status-idle" aria-label="done" />;
  if (status === 'error')
    return <TriangleAlert className="size-3.5 shrink-0 text-status-error" aria-label="error" />;
  return <Wrench className="size-3.5 shrink-0 text-flock-ink-muted" aria-label="pending" />;
}

/** A structuredPatch rendered as +/- lines with red/green gutters. */
function DiffView({ hunks }: { hunks: DiffHunk[] }): JSX.Element {
  return (
    <div className="overflow-x-auto border-t border-[var(--flock-border)] font-mono text-2xs leading-relaxed">
      {hunks.map((hunk, hi) => (
        <div key={hi}>
          {(hunk.lines ?? []).map((line, li) => {
            const sign = line.charAt(0);
            const cls =
              sign === '+'
                ? 'bg-status-idle/10 text-status-idle'
                : sign === '-'
                  ? 'bg-status-error/10 text-status-error'
                  : 'text-flock-ink-muted';
            return (
              <div key={li} className={`whitespace-pre px-3 ${cls}`}>
                {line}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * A tool call rendered as a card: icon · title · one-line args summary · status,
 * with a collapsible section showing the diff (structuredPatch, red/green) or the
 * result text. All of input/diff/output are optional — a name-only tool (ACP, or
 * before agentd ships the structured fields) still renders cleanly.
 */
function ToolCard({ item }: { item: ToolItem }): JSX.Element {
  const [open, setOpen] = useState(false);
  const hasDiff = item.diff != null && item.diff.length > 0;
  const output = item.output ?? item.detail;
  const hasOutput = output != null && output.length > 0;
  const expandable = hasDiff || hasOutput;
  return (
    <div
      data-testid="chat-tool-card"
      className="rounded-lg border border-[var(--flock-border)] bg-flock-surface-1"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={!expandable}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-flock-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-flock-surface-2">
          <Wrench className="size-3 text-flock-ink-muted" />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 font-mono text-2xs font-semibold text-flock-ink-primary">
            {item.title}
          </span>
          {item.input ? (
            <span
              className="min-w-0 truncate font-mono text-2xs text-flock-ink-muted"
              data-testid="chat-tool-input"
            >
              {item.input}
            </span>
          ) : null}
        </span>
        <ToolStatusIcon status={item.status} />
        {expandable ? (
          <ChevronRight
            className={`size-3.5 shrink-0 text-flock-ink-muted transition-transform ${open ? 'rotate-90' : ''}`}
          />
        ) : null}
      </button>
      {open && hasDiff ? (
        <div data-testid="chat-tool-diff">
          <DiffView hunks={item.diff!} />
        </div>
      ) : open && hasOutput ? (
        <pre
          data-testid="chat-tool-output"
          className="overflow-x-auto border-t border-[var(--flock-border)] px-3 py-2 font-mono text-2xs leading-relaxed text-flock-ink-primary"
        >
          <code>{output}</code>
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
 * A permission/input request the agent is blocked on. For Claude's stream-json
 * transport this is a REAL audited approval: agentd surfaces a `can_use_tool`
 * control_request as `request.opened` (carrying the tool name + args), and
 * Approve/Deny type 'y'/'n' into the session's stdin, which agentd's driver
 * consumes as the control_response answer (NOT a prompt). `request.resolved`
 * greys the card out once answered.
 */
function RequestCard({
  item,
  sessionId,
}: {
  item: Extract<TimelineItem, { kind: 'request' }>;
  sessionId: string;
}): JSX.Element {
  // Route to THIS session's PTY (per-session writer), not the global focused-terminal
  // seam — so an approval in a non-focused grid tile reaches its own agent.
  const respond = (text: string): void => typeToSession(sessionId, `${text}\r`);
  const isPermission = item.requestKind === 'permission';
  // "Approve <tool> — <args>?" so the operator sees WHAT they're approving.
  const heading = item.title
    ? isPermission
      ? `Approve ${item.title}`
      : item.title
    : isPermission
      ? 'Approval requested'
      : 'Input requested';
  return (
    <div
      data-testid="chat-request-card"
      data-resolved={item.resolved ? 'true' : 'false'}
      className={`rounded-lg border px-3 py-2 ${
        item.resolved
          ? 'border-[var(--flock-border)] bg-flock-surface-1 opacity-60'
          : 'border-status-awaiting/40 bg-status-awaiting/5'
      }`}
    >
      <div className="flex min-w-0 items-baseline gap-1.5 text-xs font-medium text-flock-ink-primary">
        <ShieldAlert
          className={`size-3.5 shrink-0 self-center ${item.resolved ? 'text-flock-ink-muted' : 'text-status-awaiting'}`}
        />
        <span className="shrink-0">{heading}</span>
        {item.input ? (
          <span
            className="min-w-0 truncate font-mono text-2xs text-flock-ink-muted"
            data-testid="chat-request-input"
          >
            — {item.input}
          </span>
        ) : null}
        {isPermission && !item.input ? <span aria-hidden>?</span> : null}
      </div>
      {isPermission && !item.resolved ? (
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
      ) : item.resolved ? (
        <div className="mt-1.5 text-2xs text-flock-ink-muted">Resolved</div>
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
    <div
      className="flex items-center gap-2 px-1 text-2xs text-flock-ink-muted"
      data-testid="chat-working"
    >
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
  // The user's own message: a compact right-aligned block so it reads as "mine"
  // without eating the column — the assistant reply gets the full width.
  if (msg.role === 'user') {
    return (
      <div className="group flex flex-col items-end gap-0.5">
        <div className="min-w-0 max-w-[85%] whitespace-pre-wrap break-words rounded-2xl border border-[var(--flock-border)] bg-flock-surface-2 px-3.5 py-2 text-xs leading-relaxed text-flock-ink-primary">
          {msg.text}
        </div>
        {msg.ts ? (
          <time className="px-1 text-2xs tabular-nums text-flock-ink-muted/70">
            {chatTimeAgo(msg.ts, now)}
          </time>
        ) : null}
      </div>
    );
  }
  // The assistant reply: FULL-WIDTH prose (no bubble, no avatar), t3code-style — so
  // it uses the whole chat column instead of a narrow left bubble.
  return (
    <div className="group min-w-0">
      <div className="min-w-0 text-xs leading-relaxed text-flock-ink-primary">
        <MessageBody text={msg.text} />
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 px-0.5">
        {msg.ts ? (
          <time className="text-2xs tabular-nums text-flock-ink-muted/70">
            {chatTimeAgo(msg.ts, now)}
          </time>
        ) : null}
        <CopyButton
          text={msg.text}
          label="Copy message"
          showLabel={false}
          className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        />
      </div>
    </div>
  );
}

/** Route a timeline item to its renderer. */
function TimelineRow({
  item,
  now,
  sessionId,
}: {
  item: TimelineItem;
  now: number;
  sessionId: string;
}): JSX.Element | null {
  switch (item.kind) {
    case 'message':
      return <Bubble msg={item} now={now} />;
    case 'tool':
      return <ToolCard item={item} />;
    case 'plan':
      return <PlanCard items={item.items} />;
    case 'request':
      return <RequestCard item={item} sessionId={sessionId} />;
    case 'error':
      return <ErrorRow text={item.text} />;
    case 'commands':
      // Invisible side-channel — the dynamic slash-command catalog feeds the
      // composer's SlashMenu (via latestCommands), it isn't rendered inline.
      return null;
  }
}

/** One row in the model picker: label + a check when it's the current model. */
function ModelOption({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-flock-ink-primary transition-colors hover:bg-flock-surface-2"
    >
      <Check className={`size-3.5 shrink-0 ${active ? 'text-flock-accent' : 'invisible'}`} />
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * Bottom-left live model switcher (Phase B) — a compact combobox: pick a suggested
 * model OR type ANY alias/full id (e.g. `claude-fable-5`), since some CLIs (claude,
 * codex) don't enumerate their full model list. Choosing one relaunches the session
 * in place. The "restarts the agent" note lives INSIDE the popover (not a hover
 * tooltip that overlaps the conversation). Shown only for chat-capable agents that
 * support model selection (non-empty catalog).
 */
function ModelSwitcher({ session }: { session: Session }): JSX.Element | null {
  const { data: modelsData } = useAgentModels(session.nodeId, session.agentType);
  const relaunch = useRelaunchSession();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const models = modelsData?.models ?? [];
  if (!isChatCapable(session.agentType) || models.length === 0) return null;

  const currentModel = session.model ?? null;
  const pending = relaunch.isPending;
  const resumes = RESUMES_ON_RELAUNCH.has(session.agentType);

  const apply = (model: string | null): void => {
    setOpen(false);
    setDraft('');
    if (model === currentModel) return;
    relaunch.mutate(
      { id: session.id, patch: { model } },
      {
        // The relaunch swaps the PTY under the same id; the terminal saw the old
        // process 'exit' and won't auto-reattach, so force it to reconnect to the
        // new PTY (a short delay lets agentd finish opening it). Without this,
        // terminalInput keeps writing to the dead socket → messages go nowhere.
        onSuccess: () => window.setTimeout(() => usePaddock.getState().terminalReconnect?.(), 600),
      },
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Model"
          data-testid="chat-model-switcher"
          disabled={pending}
          className="flex h-7 max-w-[14rem] items-center gap-1 rounded-md border border-[var(--flock-border)] px-2 text-2xs text-flock-ink-primary transition-colors hover:bg-flock-surface-2 disabled:opacity-60"
        >
          {pending ? (
            <Loader2 className="size-3 shrink-0 animate-spin text-flock-ink-muted" />
          ) : (
            <Bot className="size-3 shrink-0 text-flock-ink-muted" />
          )}
          <span className="truncate">{pending ? 'Switching…' : (currentModel ?? 'Default')}</span>
          <ChevronDown className="size-3 shrink-0 text-flock-ink-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-64 p-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const t = draft.trim();
            if (t) apply(t);
          }}
          className="border-b border-[var(--flock-border)] p-2"
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type any model, e.g. claude-fable-5"
            spellCheck={false}
            autoComplete="off"
            className="h-7 text-xs"
          />
        </form>
        <div className="max-h-56 overflow-y-auto p-1">
          <ModelOption
            label="Default (CLI decides)"
            active={currentModel === null}
            onSelect={() => apply(null)}
          />
          {models.map((m) => (
            <ModelOption key={m} label={m} active={currentModel === m} onSelect={() => apply(m)} />
          ))}
        </div>
        <div className="border-t border-[var(--flock-border)] px-2.5 py-1.5 text-2xs leading-snug text-flock-ink-muted">
          Switching restarts the agent
          {resumes ? ' and resumes this conversation.' : ' as a new conversation.'}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Resolve the slash commands the composer should offer: the session's LIVE
 * commands (streamed via Claude's stream-json `init` → commands.updated events)
 * when any have arrived, else the static per-agent catalog. Live commands arrive
 * bare (e.g. "compact") — normalized to the "/compact" form the catalog and the
 * PTY both use. Pure + unit-tested.
 */
export function resolveSlashCommands(
  agentType: AgentType,
  liveCommands: string[] | null,
): readonly string[] {
  if (liveCommands && liveCommands.length > 0) {
    return liveCommands.map((c) => (c.startsWith('/') ? c : `/${c}`));
  }
  return SLASH_COMMANDS[agentType] ?? [];
}

/** Permission/autonomy mode switch (plan · accept-edits · full-access) — relaunches
 *  the agent in the chosen mode, mirroring the ModelSwitcher relaunch dance. Shown
 *  only for agents that expose modes (claude/codex/antigravity/gemini). */
function PermissionModeSwitcher({ session }: { session: Session }): JSX.Element | null {
  const relaunch = useRelaunchSession();
  const [open, setOpen] = useState(false);
  const modes = permissionModesForAgent(session.agentType);
  if (modes.length === 0) return null;
  const current = session.permissionMode;
  const pending = relaunch.isPending;

  const apply = (mode: SessionPermissionMode): void => {
    setOpen(false);
    if (mode === current) return;
    relaunch.mutate(
      { id: session.id, patch: { permissionMode: mode } },
      {
        // Same reconnect nudge as the model switch: relaunch swaps the process under
        // the same id, so force the terminal to reattach to the new one.
        onSuccess: () => window.setTimeout(() => usePaddock.getState().terminalReconnect?.(), 600),
      },
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Permission mode"
          data-testid="chat-mode-switcher"
          disabled={pending}
          className="flex h-7 items-center gap-1 rounded-md border border-[var(--flock-border)] px-2 text-2xs text-flock-ink-primary transition-colors hover:bg-flock-surface-2 disabled:opacity-60"
        >
          {pending ? (
            <Loader2 className="size-3 shrink-0 animate-spin text-flock-ink-muted" />
          ) : (
            <Shield className="size-3 shrink-0 text-flock-ink-muted" />
          )}
          <span className="truncate">
            {pending ? 'Switching…' : PERMISSION_MODE_SHORT[current]}
          </span>
          <ChevronDown className="size-3 shrink-0 text-flock-ink-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-56 p-1">
        {modes.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => apply(m)}
            className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-flock-surface-2 ${
              m === current ? 'text-flock-ink-primary' : 'text-flock-ink-muted'
            }`}
          >
            <span>{PERMISSION_MODE_LABELS[m]}</span>
            {m === current ? <Check className="size-3.5 shrink-0 text-flock-accent" /> : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Slash-command quick menu (Phase C) — sends the chosen command to the agent's
 * stdin. Prefers the session's LIVE slash commands so Claude shows its real ~40
 * commands; falls back to the static per-agent catalog before any arrive.
 */
function SlashMenu({
  session,
  liveCommands,
}: {
  session: Session;
  liveCommands: string[] | null;
}): JSX.Element | null {
  const commands = resolveSlashCommands(session.agentType, liveCommands);
  if (commands.length === 0) return null;
  const run = (cmd: string): void => typeToSession(session.id, `${cmd}\r`);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Slash commands"
          data-testid="chat-slash-menu"
          className="flex size-7 shrink-0 items-center justify-center rounded-md border border-[var(--flock-border)] text-flock-ink-muted transition-colors hover:bg-flock-surface-2 hover:text-flock-ink-primary"
        >
          <Slash className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 min-w-[10rem] overflow-y-auto">
        {commands.map((cmd) => (
          <DropdownMenuItem key={cmd} onSelect={() => run(cmd)} className="font-mono text-xs">
            {cmd}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The always-present composer — types a prompt into the agent's PTY (as stdin),
 *  with an inline toolbar: model switcher · slash menu · image upload · send. */
function Composer({
  session,
  liveCommands,
}: {
  session: Session;
  liveCommands: string[] | null;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadedName, setUploadedName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const send = (): void => {
    const text = draft.trim();
    if (text.length === 0) return;
    typeToSession(session.id, `${text}\r`);
    setDraft('');
    setUploadedName(null); // the attachment (if any) is now part of the sent prompt
  };

  // Phase D: write the picked image into the node workspace, then drop its
  // absolute path into the draft so the user can reference it by path.
  const onPickImage = async (file: File): Promise<void> => {
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error('Image is too large (max 4MB).');
      return;
    }
    setUploading(true);
    try {
      const base64 = await fileToBase64(file);
      const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_');
      const fileName = `${Date.now()}-${safeName}`;
      // Prefer a tidy .flock-uploads dir; tolerate "already exists" and fall back
      // to the workspace root if the dir can't be created at all.
      let dir = session.workingDir;
      try {
        await makeNodeDir(session.nodeId, session.workingDir, '.flock-uploads');
        dir = `${session.workingDir.replace(/\/+$/, '')}/.flock-uploads`;
      } catch {
        dir = `${session.workingDir.replace(/\/+$/, '')}/.flock-uploads`;
        // Assume "already exists"; a real failure surfaces on the write below.
      }
      let path = `${dir.replace(/\/+$/, '')}/${fileName}`;
      try {
        await writeNodeFile(session.nodeId, path, base64);
      } catch {
        // Directory couldn't be used — fall back to the workspace root.
        path = `${session.workingDir.replace(/\/+$/, '')}/${fileName}`;
        await writeNodeFile(session.nodeId, path, base64);
      }
      setDraft((d) => (d.length === 0 ? path : `${d} ${path}`));
      setUploadedName(file.name);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not upload image.');
    } finally {
      setUploading(false);
    }
  };

  return (
    // No footer bar / divider — the composer floats on the same page surface as the
    // conversation (t3code-style), so the input, model select and "/"·"+" controls
    // read as one box ON the page rather than an isolated bottom section.
    <div className="bg-flock-bg px-3 pb-3 pt-1">
      <div className="mx-auto w-full max-w-3xl rounded-2xl border border-[var(--flock-border)] bg-flock-surface-0 shadow-sm transition-colors focus-within:border-flock-accent">
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
          className="max-h-40 min-h-[2.75rem] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-xs text-flock-ink-primary outline-none focus:outline-none focus-visible:outline-none placeholder:text-flock-ink-muted"
        />
        <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
          <ModelSwitcher session={session} />
          <PermissionModeSwitcher session={session} />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            data-testid="chat-attach-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onPickImage(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            aria-label="Attach image"
            data-testid="chat-attach"
            className="flex size-7 shrink-0 items-center justify-center rounded-md border border-[var(--flock-border)] text-flock-ink-muted transition-colors hover:bg-flock-surface-2 hover:text-flock-ink-primary disabled:opacity-40"
          >
            <Plus className="size-4" />
          </button>
          <SlashMenu session={session} liveCommands={liveCommands} />
          {uploading ? (
            <span className="flex items-center gap-1 text-2xs text-flock-ink-muted">
              <Loader2 className="size-3 animate-spin" /> Uploading…
            </span>
          ) : uploadedName ? (
            <span
              className="flex items-center gap-1 truncate rounded-full bg-flock-surface-2 px-2 py-0.5 text-2xs text-flock-ink-muted"
              data-testid="chat-upload-chip"
            >
              <Paperclip className="size-3" /> uploaded {uploadedName}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={send}
              disabled={draft.trim().length === 0}
              aria-label="Send prompt"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-flock-accent text-[var(--flock-accent-foreground)] transition-opacity hover:bg-flock-accent-hover disabled:opacity-40"
            >
              <Send className="size-4" />
            </button>
          </div>
        </div>
      </div>
      <div className="mx-auto mt-1.5 flex w-full max-w-3xl items-center gap-1.5 px-1.5 text-2xs text-flock-ink-muted">
        <FolderGit2 className="size-3 shrink-0" />
        <span className="truncate" title={session.workingDir}>
          {session.workingDir}
        </span>
      </div>
    </div>
  );
}

export function ChatPanel({ session }: { session: Session }): JSX.Element {
  const { data: events = [] } = useSessionEvents(session.id);
  // The events API returns newest-first (desc seq); a chat reads oldest → newest
  // (top → bottom), and chatTimeline's tool-lifecycle merge also assumes
  // chronological order, so fold the reversed (ascending) list.
  const timeline = chatTimeline([...events].reverse());
  const liveCommands = latestCommands(timeline);
  // The `commands` item is an invisible side-channel (consumed by latestCommands for
  // the slash menu) — exclude it from what's rendered AND from the "is the chat
  // empty?" check, else a session that only posted commands.updated (from init)
  // would suppress the empty state and show a blank panel.
  const visible = timeline.filter((item) => item.kind !== 'commands');
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
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
          {visible.length === 0 && !working ? (
            <div className="flex h-full items-center justify-center p-3">
              <EmptyState
                icon={<Sheep className="text-flock-ink-muted" />}
                title="Start the conversation"
                description="Send a prompt below to talk to the agent. Structured chat fills in for ACP sessions; other agents stream in the Terminal tab."
              />
            </div>
          ) : (
            // ChatGPT-style narrow, centered reading column.
            <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-4">
              {visible.map((item) => (
                <TimelineRow key={item.id} item={item} now={now} sessionId={session.id} />
              ))}
              {working ? <WorkingRow /> : null}
            </div>
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
      <Composer session={session} liveCommands={liveCommands} />
    </div>
  );
}
