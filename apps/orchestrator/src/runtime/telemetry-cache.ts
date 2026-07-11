import type { AgentdStatusMeta } from '../nodes/agentd/protocol.js';
import { contextPct, estimateCostUsd } from '../sessions/model-info.js';

export type CachedAgentMeta = Omit<AgentdStatusMeta, 'plan'> & {
  contextPct?: number;
  costUsd?: number;
};

/** Merge sparse daemon telemetry and recompute derived display values once. */
export function mergeAgentMeta(
  previous: CachedAgentMeta,
  incoming: AgentdStatusMeta,
): CachedAgentMeta {
  const numberOrPrevious = (next: number | undefined, before: number | undefined) =>
    next && next > 0 ? next : before;
  const stringOrPrevious = (next: string | undefined, before: string | undefined) => next || before;
  const model = stringOrPrevious(incoming.model, previous.model);
  const tokens = numberOrPrevious(incoming.tokens, previous.tokens);
  const contextTokens = numberOrPrevious(incoming.contextTokens, previous.contextTokens);
  const contextLimit = numberOrPrevious(incoming.contextLimit, previous.contextLimit);
  return {
    tokens,
    tool: stringOrPrevious(incoming.tool, previous.tool),
    model,
    contextTokens,
    contextLimit,
    contextPct: contextPct(model, contextTokens, contextLimit),
    costUsd: estimateCostUsd(model, tokens),
  };
}
