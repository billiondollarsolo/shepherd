import type { AgentType, SessionPermissionMode } from '@flock/shared';

/**
 * Permission / autonomy modes shared by the new-session dialog AND the in-composer
 * mid-session switcher, so both stay in lock-step. Mirrors the orchestrator's
 * per-agent flag mapping (agent-launch.ts).
 */
export const PERMISSION_MODE_LABELS: Record<SessionPermissionMode, string> = {
  default: 'Interactive (ask)',
  acceptEdits: 'Auto-accept edits',
  plan: 'Plan (read-only)',
  autonomous: 'Autonomous (no prompts)',
};

/** Compact labels for the tight composer control. */
export const PERMISSION_MODE_SHORT: Record<SessionPermissionMode, string> = {
  default: 'Ask',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  autonomous: 'Full access',
};

/**
 * The permission modes each agent ACTUALLY supports. The four aren't interchangeable
 * across CLIs: Gemini has no read-only "plan" mode. Agents not listed (opencode =
 * in-app perms, terminal/dev) expose no picker.
 */
export const PERMISSION_MODES_BY_AGENT: Partial<
  Record<AgentType, readonly SessionPermissionMode[]>
> = {
  'claude-code': ['default', 'acceptEdits', 'plan', 'autonomous'],
  codex: ['default', 'acceptEdits', 'plan', 'autonomous'],
  antigravity: ['default', 'plan', 'acceptEdits', 'autonomous'],
  gemini: ['default', 'acceptEdits', 'autonomous'],
};

/** The modes an agent supports, or [] when it exposes no permission picker. */
export function permissionModesForAgent(
  agentType: AgentType | string | null | undefined,
): readonly SessionPermissionMode[] {
  return (agentType != null && PERMISSION_MODES_BY_AGENT[agentType as AgentType]) || [];
}
