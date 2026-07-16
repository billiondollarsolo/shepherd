import type { AgentType } from '@flock/shared';

/**
 * Agents that produce a structured transcript Shepherd can render as a chat view
 * today (via ACP for gemini, transcript/hook tailing for the rest). Everything
 * else (grok, aider, cursor-agent, amp, terminal, dev) is terminal-only by
 * nature — no first-class transcript — so the Terminal ⇄ Chat toggle isn't
 * offered for them and the terminal stays the sole view. See
 * docs/structured-chat-view-plan.md.
 */
const CHAT_CAPABLE_AGENTS: ReadonlySet<AgentType> = new Set<AgentType>([
  'claude-code',
  'codex',
  'opencode',
  'gemini',
]);

export function isChatCapable(agentType: AgentType | string | null | undefined): boolean {
  return agentType != null && CHAT_CAPABLE_AGENTS.has(agentType as AgentType);
}
