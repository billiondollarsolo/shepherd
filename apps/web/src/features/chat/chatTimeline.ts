/**
 * chatTimeline — fold the session event log into an ordered, renderable chat
 * timeline. It normalizes BOTH shapes the log can carry so the same UI works
 * today and lights up further as the live structured transport (plan §Phase 1)
 * lands:
 *   - the current transcript path: `{ chat: { role, text } }`
 *   - the F5 AgentEvent union: `{ kind: 'content.delta' | 'tool.started' |
 *     'tool.updated' | 'plan.updated' | 'request.opened' | 'request.resolved' |
 *     'error', … }` (packages/shared/src/agentEvents.ts)
 *
 * Pure and unit-tested — the ChatPanel just renders what this returns. Tool
 * lifecycle merges by toolId; the plan keeps only its latest snapshot;
 * permission/input requests track resolution so the UI can offer an approval.
 */

export type ToolStatus = 'pending' | 'running' | 'success' | 'error';
export interface PlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** One hunk of a unified diff (Claude's `structuredPatch` entry); all fields optional. */
export interface DiffHunk {
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  lines?: string[];
}

export type TimelineItem =
  | { kind: 'message'; id: string; role: 'user' | 'assistant' | 'reasoning'; text: string; ts?: string }
  | {
      kind: 'tool';
      id: string;
      title: string;
      detail?: string;
      /** A compact human summary of the tool's args (e.g. a file_path or command). */
      input?: string;
      /** The tool result's text output, when the transport carries it. */
      output?: string;
      /** Claude's structuredPatch (unified-diff hunks), when present. */
      diff?: DiffHunk[];
      status: ToolStatus;
      ts?: string;
    }
  | { kind: 'plan'; id: string; items: PlanItem[]; ts?: string }
  | {
      kind: 'request';
      id: string;
      requestKind: 'permission' | 'input';
      /** The tool name being approved (e.g. "Write"), from request.opened's title. */
      title?: string;
      /** A compact human summary of the tool's args (reuses {@link summarizeToolInput}). */
      input?: string;
      resolved: boolean;
      ts?: string;
    }
  // Invisible side-channel: the session's latest dynamic slash-command catalog
  // (Claude stream-json `init`). Not rendered — read via {@link latestCommands}.
  | { kind: 'commands'; id: string; commands: string[]; ts?: string }
  | { kind: 'error'; id: string; text: string; ts?: string };

interface RawEvent {
  id: string;
  ts?: string;
  agentEventRaw?: unknown;
}

type ChatShape = { chat?: { role?: string; text?: string } };
type F5Shape = {
  kind?: string;
  text?: string;
  streamKind?: string;
  toolId?: string;
  title?: string;
  status?: string;
  toolInput?: unknown;
  toolOutput?: string | null;
  toolDiff?: DiffHunk[] | null;
  commands?: string[];
  items?: Array<{ text?: string; status?: string }>;
  requestId?: string;
  requestKind?: string;
  message?: string;
};

/**
 * Boil a tool's args object down to a short one-line summary for the tool card
 * header — prefers the common single-value keys (file_path, command, path,
 * pattern, url), else a truncated JSON.stringify. Returns undefined for empty.
 */
export function summarizeToolInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === 'string') return input.length > 0 ? truncate(input) : undefined;
  if (typeof input !== 'object') return truncate(String(input));
  const obj = input as Record<string, unknown>;
  for (const key of ['file_path', 'command', 'path', 'pattern', 'query', 'url', 'filePath']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return truncate(v);
  }
  const json = JSON.stringify(input);
  if (!json || json === '{}') return undefined;
  return truncate(json);
}
function truncate(s: string, max = 120): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

const TOOL_STATUS: Record<string, ToolStatus> = {
  pending: 'pending',
  running: 'running',
  in_progress: 'running',
  completed: 'success',
  success: 'success',
  error: 'error',
  failed: 'error',
};

/** Turn a raw tool payload like "edit auth.ts" into a "Verb · target" title. */
export function toolTitle(raw: string): { title: string; detail?: string } {
  const firstLine = (raw.split('\n', 1)[0] ?? raw).trim();
  const rest = raw.slice(firstLine.length).replace(/^\n/, '');
  const m = /^([A-Za-z_]+)\b[\s:]*(.*)$/.exec(firstLine);
  const title = m && m[2] ? `${cap(m[1]!)} · ${m[2]}` : firstLine || 'Tool';
  return { title, detail: rest.length > 0 ? rest : undefined };
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function chatTimeline(events: ReadonlyArray<RawEvent>): TimelineItem[] {
  const out: TimelineItem[] = [];
  const toolIndex = new Map<string, number>();
  const requestIndex = new Map<string, number>();
  let planIndex: number | null = null;

  for (const e of events) {
    const raw = e.agentEventRaw as (ChatShape & F5Shape) | null | undefined;
    if (!raw || typeof raw !== 'object') continue;

    // --- current transcript path -------------------------------------------
    if (raw.chat && typeof raw.chat.text === 'string' && raw.chat.text.length > 0) {
      const role = raw.chat.role ?? 'assistant';
      if (role === 'tool') {
        const { title, detail } = toolTitle(raw.chat.text);
        out.push({ kind: 'tool', id: e.id, title, detail, status: 'success', ts: e.ts });
      } else {
        out.push({
          kind: 'message',
          id: e.id,
          role: role === 'user' ? 'user' : 'assistant',
          text: raw.chat.text,
          ts: e.ts,
        });
      }
      continue;
    }

    // --- F5 AgentEvent union -----------------------------------------------
    switch (raw.kind) {
      case 'content.delta': {
        if (!raw.text) break;
        const role = raw.streamKind === 'user_text' ? 'user' : raw.streamKind === 'reasoning_text' ? 'reasoning' : 'assistant';
        out.push({ kind: 'message', id: e.id, role, text: raw.text, ts: e.ts });
        break;
      }
      case 'tool.started': {
        const idx =
          out.push({
            kind: 'tool',
            id: raw.toolId ?? e.id,
            title: raw.title ?? cap(raw.toolId ?? 'tool'),
            input: summarizeToolInput(raw.toolInput),
            status: 'running',
            ts: e.ts,
          }) - 1;
        if (raw.toolId) toolIndex.set(raw.toolId, idx);
        break;
      }
      case 'tool.updated': {
        const idx = raw.toolId != null ? toolIndex.get(raw.toolId) : undefined;
        const status = raw.status ? (TOOL_STATUS[raw.status] ?? 'running') : 'running';
        const output = raw.toolOutput != null && raw.toolOutput.length > 0 ? raw.toolOutput : undefined;
        const diff = Array.isArray(raw.toolDiff) && raw.toolDiff.length > 0 ? raw.toolDiff : undefined;
        if (idx != null) {
          const item = out[idx];
          if (item && item.kind === 'tool') {
            item.status = status;
            if (output != null) item.output = output;
            if (diff != null) item.diff = diff;
          }
        } else {
          out.push({ kind: 'tool', id: raw.toolId ?? e.id, title: raw.title ?? 'Tool', status, output, diff, ts: e.ts });
        }
        break;
      }
      case 'commands.updated': {
        if (Array.isArray(raw.commands)) {
          out.push({ kind: 'commands', id: e.id, commands: raw.commands, ts: e.ts });
        }
        break;
      }
      case 'plan.updated': {
        const items: PlanItem[] = (raw.items ?? []).map((it) => ({
          text: it.text ?? '',
          status: it.status === 'in_progress' || it.status === 'completed' ? it.status : 'pending',
        }));
        if (planIndex != null) out[planIndex] = { kind: 'plan', id: e.id, items, ts: e.ts };
        else planIndex = out.push({ kind: 'plan', id: e.id, items, ts: e.ts }) - 1;
        break;
      }
      case 'request.opened': {
        const idx =
          out.push({
            kind: 'request',
            id: raw.requestId ?? e.id,
            requestKind: raw.requestKind === 'input' ? 'input' : 'permission',
            title: raw.title,
            input: summarizeToolInput(raw.toolInput),
            resolved: false,
            ts: e.ts,
          }) - 1;
        if (raw.requestId) requestIndex.set(raw.requestId, idx);
        break;
      }
      case 'request.resolved': {
        const idx = raw.requestId != null ? requestIndex.get(raw.requestId) : undefined;
        if (idx != null) {
          const item = out[idx];
          if (item && item.kind === 'request') item.resolved = true;
        }
        break;
      }
      case 'error': {
        if (raw.message) out.push({ kind: 'error', id: e.id, text: raw.message, ts: e.ts });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** The newest unresolved permission/input request, if any (drives the approval UI). */
export function pendingRequest(items: readonly TimelineItem[]): Extract<TimelineItem, { kind: 'request' }> | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'request' && !it.resolved) return it;
  }
  return null;
}

/**
 * The session's most-recent dynamic slash-command catalog (from `commands.updated`
 * events), or `null` if none has arrived — so the composer can prefer the agent's
 * REAL commands and fall back to its static catalog otherwise.
 */
export function latestCommands(items: readonly TimelineItem[]): string[] | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'commands') return it.commands;
  }
  return null;
}
