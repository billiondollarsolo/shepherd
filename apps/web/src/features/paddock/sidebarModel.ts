import type { AgentType, Session, SessionPermissionMode } from '@flock/shared';

export const AGENT_SHORT: Record<AgentType, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  grok: 'Grok',
  aider: 'Aider',
  'cursor-agent': 'Cursor',
  amp: 'Amp',
  terminal: 'Terminal',
  dev: 'Dev',
};

/** Stable empty list so nodes with no sessions don't get a fresh array each render. */

export const MODE_BADGE: Partial<
  Record<SessionPermissionMode, { label: string; title: string; cls: string }>
> = {
  plan: {
    label: 'PLAN',
    title: 'Plan mode — read-only until you approve',
    cls: 'text-flock-accent',
  },
  acceptEdits: { label: 'AUTO', title: 'Auto-accept edits', cls: 'text-status-awaiting' },
  autonomous: {
    label: 'YOLO',
    title: 'Autonomous — no approval prompts',
    cls: 'text-status-error',
  },
};

/** Sort rank by status: the agents that need you float to the top of the sidebar. */
export const STATUS_RANK: Record<string, number> = {
  awaiting_input: 0,
  error: 1,
  running: 2,
  starting: 3,
  idle: 4,
  done: 5,
  disconnected: 6,
};

/** Tailwind bg for a node's connection status — the little dot on the rail's node icon. */
export const NODE_CONN_BG: Record<string, string> = {
  connected: 'bg-status-idle',
  connecting: 'bg-status-awaiting',
  disconnected: 'bg-status-disconnected',
  error: 'bg-status-error',
};

export function sessionLabel(s: Session): string {
  return `${AGENT_SHORT[s.agentType]} · ${s.id.slice(0, 6)}`;
}

/** Move one id to the target position; invalid/no-op input preserves identity. */
export function reorderNodeIds(
  ids: readonly string[],
  draggedId: string,
  targetId: string,
): string[] {
  if (draggedId === targetId) return [...ids];
  const from = ids.indexOf(draggedId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0) return [...ids];
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, draggedId);
  return next;
}
