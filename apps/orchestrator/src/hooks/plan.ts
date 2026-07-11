/**
 * Plan/todo extraction from raw agent hook payloads (US-34 Plan artifact).
 *
 * The agent's plan is NOT a status transition — it rides the SAME hook callbacks
 * Flock already receives. Claude Code surfaces its plan through the `TodoWrite`
 * tool: a `PostToolUse` (or `PreToolUse`) hook with `tool_name: "TodoWrite"` and
 * `tool_input.todos: [{ content, status, activeForm }]`. Because the hook
 * template already forwards `Pre/PostToolUse` and the payload is stored raw, the
 * plan data already arrives — this module just normalizes it into the shared
 * {@link PlanItem} shape so the endpoint can append a `plan` event.
 *
 * Pure + framework-free (mirrors `translate.ts`); returns `null` when the payload
 * carries no plan so the caller skips the extra event. Only Claude is wired today
 * (the primary agent); Codex/OpenCode return `null` until their plan tools are
 * mapped.
 */
import type { AgentType, PlanItem, PlanItemStatus } from '@flock/shared';

/** The normalized plan snapshot stored in a `plan` event's `agent_event_raw`. */
export interface ExtractedPlan {
  readonly items: PlanItem[];
}

/** Per-session last-emitted plan (serialized), so identical plans aren't re-stored. */
const lastPlanBySession = new Map<string, string>();

/** The variable fields of a `plan` event (the caller adds `sessionId` + `source`). */
export interface PlanEventFields {
  readonly type: 'plan';
  readonly mappedStatus: null;
  readonly agentEventRaw: { items: PlanItem[] };
  readonly detail: string;
}

/**
 * Build the fields for a `plan` artifact event IF the plan changed for this
 * session, else `null` (deduped). Shared by BOTH plan sources — the hook path
 * (Claude TodoWrite) and the status-channel path (Codex update_plan) — so the
 * dedup + event shape live in one place and the hook path gets dedup too.
 */
export function planEventFields(sessionId: string, items: PlanItem[]): PlanEventFields | null {
  if (items.length === 0) return null;
  const key = JSON.stringify(items);
  if (lastPlanBySession.get(sessionId) === key) return null;
  lastPlanBySession.set(sessionId, key);
  return {
    type: 'plan',
    mappedStatus: null,
    agentEventRaw: { items },
    detail: `${items.length} plan item${items.length === 1 ? '' : 's'}`,
  };
}

function normalizeStatus(raw: unknown): PlanItemStatus {
  return raw === 'in_progress' || raw === 'completed' ? raw : 'pending';
}

/** Claude Code: a TodoWrite tool call carries the plan in `tool_input.todos`. */
function extractClaudePlan(body: unknown): ExtractedPlan | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.tool_name !== 'TodoWrite') return null;

  const toolInput = b.tool_input;
  const todos =
    toolInput && typeof toolInput === 'object'
      ? (toolInput as Record<string, unknown>).todos
      : undefined;
  if (!Array.isArray(todos)) return null;

  const items: PlanItem[] = [];
  for (const todo of todos) {
    if (todo === null || typeof todo !== 'object') continue;
    const t = todo as Record<string, unknown>;
    // `content` is the canonical field; fall back to `activeForm` (in-progress
    // phrasing) so an item never renders blank.
    const content =
      typeof t.content === 'string' && t.content.trim()
        ? t.content
        : typeof t.activeForm === 'string'
          ? t.activeForm
          : '';
    if (!content.trim()) continue;
    items.push({ content, status: normalizeStatus(t.status) });
  }
  return items.length > 0 ? { items } : null;
}

/** OpenCode: a `todo.updated` event carries the plan in `properties.todos`. */
function extractOpenCodePlan(body: unknown): ExtractedPlan | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.type !== 'todo.updated') return null;
  const props = b.properties as Record<string, unknown> | undefined;
  const todos = props?.todos;
  if (!Array.isArray(todos)) return null;
  const items: PlanItem[] = [];
  for (const todo of todos) {
    if (todo === null || typeof todo !== 'object') continue;
    const t = todo as Record<string, unknown>;
    const content = typeof t.content === 'string' ? t.content.trim() : '';
    if (!content) continue;
    items.push({ content, status: normalizeStatus(t.status) });
  }
  return items.length > 0 ? { items } : null;
}

/**
 * Extract the agent's plan from a raw hook payload, or `null` when there is none.
 * Selects by `agentType`; falls back to inferring Claude from the payload shape
 * (mirrors {@link translateHookEvent}) so it works before the agent type is
 * threaded through.
 */
export function extractPlan(body: unknown, agentType?: AgentType): ExtractedPlan | null {
  switch (agentType) {
    case 'claude-code':
      return extractClaudePlan(body);
    case 'opencode':
      return extractOpenCodePlan(body);
    case 'codex':
    case 'grok':
    case 'gemini':
    case 'terminal':
      // No recognized plan/todo tool in the hook stream for these today.
      // Codex plan arrives via the transcript/status channel (`update_plan`).
      return null;
    default:
      break;
  }
  // No explicit agent type: infer from payload shape so plan still works when
  // the route/live binding has not threaded agentType yet.
  if (body !== null && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (b.type === 'todo.updated' || b.agentType === 'opencode') {
      return extractOpenCodePlan(body);
    }
    if ('hook_event_name' in b) {
      return extractClaudePlan(body);
    }
  }
  return null;
}
